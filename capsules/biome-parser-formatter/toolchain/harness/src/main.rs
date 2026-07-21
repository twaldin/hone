use biome_css_formatter::{context::CssFormatOptions, format_node as format_css_node};
use biome_css_parser::{CssParserOptions, parse_css};
use biome_js_formatter::{context::JsFormatOptions, format_node as format_js_node};
use biome_js_parser::{JsParserOptions, parse as parse_js};
use biome_languages::{CssFileSource, JsFileSource};
use biome_rowan::{AstNode, Direction, Language, SyntaxKind, SyntaxNode};
use std::env;
use std::fs;
use std::hint::black_box;
use std::path::Path;

/// FNV-1a 64 over the full element stream (kind + trimmed range) of a syntax
/// tree. Reproducing this fingerprint requires materializing the exact tree
/// the pinned parser produces; the trusted evaluator compares it against a
/// protected oracle value, so benchmark completion is bound to real parser
/// output rather than to anything the benchmark process merely claims.
fn tree_fingerprint<L: Language>(root: &SyntaxNode<L>) -> (u64, u64) {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET;
    let mut elements = 0u64;
    let mut mix = |value: u64, hash: &mut u64| {
        for byte in value.to_le_bytes() {
            *hash ^= u64::from(byte);
            *hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    for element in root.descendants_with_tokens(Direction::Next) {
        let range = element.text_trimmed_range();
        mix(u64::from(element.kind().to_raw().0), &mut hash);
        mix(u64::from(u32::from(range.start())), &mut hash);
        mix(u64::from(u32::from(range.len())), &mut hash);
        elements += 1;
    }
    (hash, elements)
}

fn js_source(path: &Path) -> JsFileSource {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("ts") => JsFileSource::ts(),
        Some("tsx") => JsFileSource::tsx(),
        Some("jsx") => JsFileSource::jsx(),
        Some("cjs") => JsFileSource::js_script(),
        _ => JsFileSource::js_module(),
    }
}

fn format_js(code: &str, source: JsFileSource) -> Result<(String, String), String> {
    let parsed = parse_js(code, source, JsParserOptions::default());
    let diagnostics = format!("{:?}", parsed.diagnostics());
    let formatted = format_js_node(JsFormatOptions::default(), parsed.tree().syntax(), Vec::new())
        .map_err(|err| format!("JS format failed: {err}"))?;
    let printed = formatted
        .print()
        .map_err(|err| format!("JS print failed: {err}"))?;
    Ok((printed.into_code(), diagnostics))
}

fn format_css(code: &str) -> Result<(String, String), String> {
    let parsed = parse_css(code, CssFileSource::css(), CssParserOptions::default());
    let diagnostics = format!("{:?}", parsed.diagnostics());
    let formatted = format_css_node(CssFormatOptions::default(), parsed.tree().syntax())
        .map_err(|err| format!("CSS format failed: {err}"))?;
    let printed = formatted
        .print()
        .map_err(|err| format!("CSS print failed: {err}"))?;
    Ok((printed.into_code(), diagnostics))
}

fn verify(path: &Path, output: &Path, second: &Path, diagnostics: &Path) -> Result<(), String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    let is_css = path.extension().and_then(|ext| ext.to_str()) == Some("css");
    let (formatted, first_diagnostics) = if is_css {
        format_css(&code)?
    } else {
        format_js(&code, js_source(path))?
    };
    let (formatted_twice, second_diagnostics) = if is_css {
        format_css(&formatted)?
    } else {
        format_js(&formatted, js_source(path))?
    };
    fs::write(output, formatted).map_err(|err| format!("output write failed: {err}"))?;
    fs::write(second, formatted_twice).map_err(|err| format!("second write failed: {err}"))?;
    fs::write(
        diagnostics,
        format!("first={first_diagnostics}\nsecond={second_diagnostics}\n"),
    )
    .map_err(|err| format!("diagnostic write failed: {err}"))?;
    Ok(())
}

fn write_parse_receipt(
    receipt: &Path,
    range_len: u32,
    fingerprint: u64,
    elements: u64,
    diagnostics: &str,
) -> Result<(), String> {
    fs::write(
        receipt,
        format!(
            "hone-biome-parse-receipt-v2\nrange={range_len}\nelements={elements}\nfingerprint={fingerprint:016x}\ndiagnostics={diagnostics}\n"
        ),
    )
    .map_err(|err| format!("receipt write failed: {err}"))
}

/// Parse benchmark: repeat the full uncached parse, then bind completion by
/// writing a receipt derived from the final iteration's tree and diagnostics.
/// This binary never reports timing; the trusted evaluator measures wall time
/// around the whole process.
fn bench_parse(path: &Path, repetitions: usize, receipt: &Path) -> Result<(), String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
        let mut last = None;
        for _ in 0..repetitions {
            // Drop the previous iteration's tree before building the next so
            // only one full parse tree is ever live — matches the baseline
            // peak RSS profile of an uncached one-shot parse.
            last = None;
            let parsed = black_box(parse_css(
                black_box(&code),
                CssFileSource::css(),
                CssParserOptions::default(),
            ));
            last = Some(parsed);
        }
        let parsed = last.ok_or_else(|| "repetitions must be positive".to_string())?;
        let syntax = parsed.syntax();
        let (fingerprint, elements) = tree_fingerprint(&syntax);
        write_parse_receipt(
            receipt,
            u32::from(syntax.text_trimmed_range().len()),
            fingerprint,
            elements,
            &format!("{:?}", parsed.diagnostics()),
        )
    } else {
        let source = js_source(path);
        let mut last = None;
        for _ in 0..repetitions {
            last = None;
            let parsed = black_box(parse_js(
                black_box(&code),
                source,
                JsParserOptions::default(),
            ));
            last = Some(parsed);
        }
        let parsed = last.ok_or_else(|| "repetitions must be positive".to_string())?;
        let syntax = parsed.syntax();
        let (fingerprint, elements) = tree_fingerprint(&syntax);
        write_parse_receipt(
            receipt,
            u32::from(syntax.text_trimmed_range().len()),
            fingerprint,
            elements,
            &format!("{:?}", parsed.diagnostics()),
        )
    }
}

/// Format benchmark: parse once, repeat format+print, then bind completion by
/// writing the final printed output. The trusted evaluator checks the receipt
/// bytes against the protected byte-exact formatting oracle.
fn bench_format(path: &Path, repetitions: usize, receipt: &Path) -> Result<(), String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    let printed_code = if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
        let parsed = parse_css(&code, CssFileSource::css(), CssParserOptions::default());
        let mut last = None;
        for _ in 0..repetitions {
            let formatted = format_css_node(
                CssFormatOptions::default(),
                black_box(parsed.tree()).syntax(),
            )
            .map_err(|err| format!("CSS format failed: {err}"))?;
            let printed = formatted
                .print()
                .map_err(|err| format!("CSS print failed: {err}"))?;
            last = Some(printed);
        }
        last.ok_or_else(|| "repetitions must be positive".to_string())?
            .into_code()
    } else {
        let parsed = parse_js(&code, js_source(path), JsParserOptions::default());
        let mut last = None;
        for _ in 0..repetitions {
            let formatted = format_js_node(
                JsFormatOptions::default(),
                black_box(parsed.tree()).syntax(),
                Vec::new(),
            )
            .map_err(|err| format!("JS format failed: {err}"))?;
            let printed = formatted
                .print()
                .map_err(|err| format!("JS print failed: {err}"))?;
            last = Some(printed);
        }
        last.ok_or_else(|| "repetitions must be positive".to_string())?
            .into_code()
    };
    fs::write(receipt, printed_code).map_err(|err| format!("receipt write failed: {err}"))
}

const SELFTEST_CHECKS: [&str; 6] = [
    "js-valid",
    "js-recovery",
    "js-format",
    "css-valid",
    "css-recovery",
    "css-format",
];

/// One named regression check. Every check performs its full body and returns
/// a receipt string embedding values that only fall out of actually doing the
/// work (tree fingerprints, diagnostic counts, formatted output). The trusted
/// evaluator runs each check as its own process and requires the exact
/// protected receipt for every check before accepting the regression gate.
fn selftest_check(check: &str) -> Result<String, String> {
    match check {
        "js-valid" => {
            let parsed = parse_js(
                "export function value<T>(input: T): T { return input; }\n",
                JsFileSource::ts(),
                JsParserOptions::default(),
            );
            if parsed.has_errors() {
                return Err(format!(
                    "upstream JS/TS valid-parse regression: {:?}",
                    parsed.diagnostics()
                ));
            }
            let syntax = parsed.syntax();
            let (fingerprint, elements) = tree_fingerprint(&syntax);
            Ok(format!(
                "check=js-valid\nrange={}\nelements={elements}\nfingerprint={fingerprint:016x}\ndiagnostics={}\n",
                u32::from(syntax.text_trimmed_range().len()),
                parsed.diagnostics().len(),
            ))
        }
        "js-recovery" => {
            let parsed = parse_js(
                "export const broken = { value: };",
                JsFileSource::js_module(),
                JsParserOptions::default(),
            );
            if !parsed.has_errors() {
                return Err("upstream JS parser recovery regression".to_string());
            }
            let syntax = parsed.syntax();
            let (fingerprint, elements) = tree_fingerprint(&syntax);
            Ok(format!(
                "check=js-recovery\nrange={}\nelements={elements}\nfingerprint={fingerprint:016x}\ndiagnostics={}\n",
                u32::from(syntax.text_trimmed_range().len()),
                parsed.diagnostics().len(),
            ))
        }
        "js-format" => {
            let (once, _) = format_js(
                "export function double(value){return [value,value+1].map(item=>item*2)}",
                JsFileSource::js_module(),
            )?;
            let (twice, _) = format_js(&once, JsFileSource::js_module())?;
            if once != twice || !once.contains("return [value, value + 1].map") {
                return Err("upstream JS formatter exact/idempotence regression".to_string());
            }
            Ok(format!(
                "check=js-format\nstable=true\nbytes={}\noutput={once}",
                once.len()
            ))
        }
        "css-valid" => {
            let parsed = parse_css(
                "@media (min-width: 40rem) { html { color: red; } }",
                CssFileSource::css(),
                CssParserOptions::default(),
            );
            if parsed.has_errors() {
                return Err(format!(
                    "upstream CSS valid-parse regression: {:?}",
                    parsed.diagnostics()
                ));
            }
            let syntax = parsed.syntax();
            let (fingerprint, elements) = tree_fingerprint(&syntax);
            Ok(format!(
                "check=css-valid\nrange={}\nelements={elements}\nfingerprint={fingerprint:016x}\ndiagnostics={}\n",
                u32::from(syntax.text_trimmed_range().len()),
                parsed.diagnostics().len(),
            ))
        }
        "css-recovery" => {
            let parsed = parse_css(
                "html { color:",
                CssFileSource::css(),
                CssParserOptions::default(),
            );
            if !parsed.has_errors() {
                return Err("upstream CSS parser recovery regression".to_string());
            }
            let syntax = parsed.syntax();
            let (fingerprint, elements) = tree_fingerprint(&syntax);
            Ok(format!(
                "check=css-recovery\nrange={}\nelements={elements}\nfingerprint={fingerprint:016x}\ndiagnostics={}\n",
                u32::from(syntax.text_trimmed_range().len()),
                parsed.diagnostics().len(),
            ))
        }
        "css-format" => {
            let (once, _) = format_css("html{}")?;
            let (twice, _) = format_css(&once)?;
            if once != "html {\n}\n" || once != twice {
                return Err("upstream CSS formatter exact/idempotence regression".to_string());
            }
            Ok(format!(
                "check=css-format\nstable=true\nbytes={}\noutput={once}",
                once.len()
            ))
        }
        _ => Err(format!("unknown selftest check: {check}")),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    match args.as_slice() {
        [_, command] if command == "selftest" => {
            for check in SELFTEST_CHECKS {
                selftest_check(check)?;
            }
            Ok(())
        }
        [_, command, check, receipt] if command == "selftest" => {
            let body = selftest_check(check)?;
            fs::write(Path::new(receipt), body)
                .map_err(|err| format!("receipt write failed: {err}"))
        }
        [_, command, input, output, second, diagnostics] if command == "verify" => verify(
            Path::new(input),
            Path::new(output),
            Path::new(second),
            Path::new(diagnostics),
        ),
        [_, command, input, repetitions, receipt] if command == "parse" || command == "format" => {
            let repetitions = repetitions
                .parse::<usize>()
                .map_err(|_| "repetitions must be a positive integer".to_string())?;
            if repetitions == 0 {
                return Err("repetitions must be positive".to_string());
            }
            if command == "parse" {
                bench_parse(Path::new(input), repetitions, Path::new(receipt))
            } else {
                bench_format(Path::new(input), repetitions, Path::new(receipt))
            }
        }
        _ => Err(
            "usage: hone_biome_bench selftest [CHECK RECEIPT] | verify INPUT OUTPUT SECOND DIAGNOSTICS | (parse|format) INPUT REPS RECEIPT"
                .to_string(),
        ),
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(2);
    }
}
