use biome_css_formatter::{context::CssFormatOptions, format_node as format_css_node};
use biome_css_parser::{CssParserOptions, parse_css};
use biome_js_formatter::{context::JsFormatOptions, format_node as format_js_node};
use biome_js_parser::{JsParserOptions, parse as parse_js};
use biome_languages::{CssFileSource, JsFileSource};
use biome_rowan::AstNode;
use std::env;
use std::fs;
use std::hint::black_box;
use std::path::Path;
#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}

unsafe extern "C" {
    fn clock_gettime(clock_id: i32, timespec: *mut Timespec) -> i32;
}

fn cpu_time_ns() -> u128 {
    let mut value = Timespec { tv_sec: 0, tv_nsec: 0 };
    // CLOCK_PROCESS_CPUTIME_ID is Linux ABI value 2.
    let status = unsafe { clock_gettime(2, &mut value) };
    assert_eq!(status, 0, "clock_gettime(CLOCK_PROCESS_CPUTIME_ID) failed");
    (value.tv_sec as u128) * 1_000_000_000 + value.tv_nsec as u128
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

fn bench_parse(path: &Path, repetitions: usize) -> Result<(usize, u128), String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    let mut witness = 0usize;
    let started = cpu_time_ns();
    if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
        for _ in 0..repetitions {
            let parsed = black_box(parse_css(
                black_box(&code),
                CssFileSource::css(),
                CssParserOptions::default(),
            ));
            witness ^= u32::from(parsed.syntax().text_trimmed_range().len()) as usize;
            witness = witness.wrapping_add(parsed.diagnostics().len());
        }
    } else {
        let source = js_source(path);
        for _ in 0..repetitions {
            let parsed = black_box(parse_js(
                black_box(&code),
                source,
                JsParserOptions::default(),
            ));
            witness ^= u32::from(parsed.syntax().text_trimmed_range().len()) as usize;
            witness = witness.wrapping_add(parsed.diagnostics().len());
        }
    }
    Ok((black_box(witness), cpu_time_ns() - started))
}

fn bench_format(path: &Path, repetitions: usize) -> Result<(usize, u128), String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    let mut witness = 0usize;
    let elapsed_ns = if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
        let parsed = parse_css(&code, CssFileSource::css(), CssParserOptions::default());
        let started = cpu_time_ns();
        for _ in 0..repetitions {
            let formatted = format_css_node(
                CssFormatOptions::default(),
                black_box(parsed.tree()).syntax(),
            )
            .map_err(|err| format!("CSS format failed: {err}"))?;
            let printed = formatted
                .print()
                .map_err(|err| format!("CSS print failed: {err}"))?;
            witness ^= black_box(printed.as_code().len());
        }
        cpu_time_ns() - started
    } else {
        let parsed = parse_js(&code, js_source(path), JsParserOptions::default());
        let started = cpu_time_ns();
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
            witness ^= black_box(printed.as_code().len());
        }
        cpu_time_ns() - started
    };
    Ok((black_box(witness), elapsed_ns))
}

fn selftest() -> Result<(), String> {
    let js_valid = "export function value<T>(input: T): T { return input; }\n";
    let js_parse = parse_js(js_valid, JsFileSource::ts(), JsParserOptions::default());
    if js_parse.has_errors() {
        return Err(format!("upstream JS/TS valid-parse regression: {:?}", js_parse.diagnostics()));
    }
    let js_invalid = parse_js(
        "export const broken = { value: };",
        JsFileSource::js_module(),
        JsParserOptions::default(),
    );
    if !js_invalid.has_errors() {
        return Err("upstream JS parser recovery regression".to_string());
    }
    let (js_once, _) = format_js(
        "export function double(value){return [value,value+1].map(item=>item*2)}",
        JsFileSource::js_module(),
    )?;
    let (js_twice, _) = format_js(&js_once, JsFileSource::js_module())?;
    if js_once != js_twice || !js_once.contains("return [value, value + 1].map") {
        return Err("upstream JS formatter exact/idempotence regression".to_string());
    }

    let css_valid = parse_css(
        "@media (min-width: 40rem) { html { color: red; } }",
        CssFileSource::css(),
        CssParserOptions::default(),
    );
    if css_valid.has_errors() {
        return Err(format!("upstream CSS valid-parse regression: {:?}", css_valid.diagnostics()));
    }
    let css_invalid = parse_css("html { color:", CssFileSource::css(), CssParserOptions::default());
    if !css_invalid.has_errors() {
        return Err("upstream CSS parser recovery regression".to_string());
    }
    let (css_once, _) = format_css("html{}")?;
    let (css_twice, _) = format_css(&css_once)?;
    if css_once != "html {\n}\n" || css_once != css_twice {
        return Err("upstream CSS formatter exact/idempotence regression".to_string());
    }
    Ok(())
}


fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    match args.as_slice() {
        [_, command] if command == "selftest" => selftest(),
        [_, command, input, output, second, diagnostics] if command == "verify" => verify(
            Path::new(input),
            Path::new(output),
            Path::new(second),
            Path::new(diagnostics),
        ),
        [_, command, input, repetitions] if command == "parse" || command == "format" => {
            let repetitions = repetitions
                .parse::<usize>()
                .map_err(|_| "repetitions must be a positive integer".to_string())?;
            if repetitions == 0 {
                return Err("repetitions must be positive".to_string());
            }
            let (witness, elapsed_ns) = if command == "parse" {
                bench_parse(Path::new(input), repetitions)?
            } else {
                bench_format(Path::new(input), repetitions)?
            };
            println!("{elapsed_ns} {witness}");
            Ok(())
        }
        _ => Err("usage: hone_biome_bench selftest | verify INPUT OUTPUT SECOND DIAGNOSTICS | (parse|format) INPUT REPS".to_string()),
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(2);
    }
}
