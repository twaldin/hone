use biome_css_formatter::{context::CssFormatOptions, format_node as format_css_node};
use biome_css_parser::{CssParserOptions, parse_css};
use biome_js_formatter::{context::JsFormatOptions, format_node as format_js_node};
use biome_js_parser::{JsParserOptions, parse as parse_js};
use biome_languages::{CssFileSource, JsFileSource};
use biome_rowan::{
    AstNode, Direction, Language, SyntaxNode, SyntaxToken, SyntaxKind, TextRange, TextSize,
    TriviaPiece,
};
use std::collections::hash_map::RandomState;
use std::env;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::hint::black_box;
use std::path::Path;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv_mix(hash: &mut u64, value: u64) {
    for byte in value.to_le_bytes() {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

/// FNV-1a 64 over the full element stream (kind + trimmed range) of a syntax
/// tree. Reproducing this fingerprint requires materializing the exact tree
/// the pinned parser produces; the trusted evaluator compares it against a
/// protected oracle value, so benchmark completion is bound to real parser
/// output rather than to anything the benchmark process merely claims.
fn tree_fingerprint<L: Language>(root: &SyntaxNode<L>) -> (u64, u64) {
    let mut hash = FNV_OFFSET;
    let mut elements = 0u64;
    for element in root.descendants_with_tokens(Direction::Next) {
        let range = element.text_trimmed_range();
        fnv_mix(&mut hash, u64::from(element.kind().to_raw().0));
        fnv_mix(&mut hash, u64::from(u32::from(range.start())));
        fnv_mix(&mut hash, u64::from(u32::from(range.len())));
        elements += 1;
    }
    (hash, elements)
}

/// Number of per-iteration shape probes at process-random byte offsets and of
/// per-iteration probes at rotated digit positions. Probe cost is a handful
/// of O(log n) tree descents, so validation stays far below parse cost and
/// the measured workload magnitude is preserved.
const UNIFORM_PROBES: usize = 12;
const ROTATED_PROBES: usize = 8;

/// Process-entropy keyed draw (SipHash seeded from OS entropy per process),
/// so candidate-controlled code cannot know at build time which offsets and
/// which iteration get probed or deep-checked.
fn entropy_draw(state: &RandomState, lane: u64, a: u64, b: u64) -> u64 {
    let mut hasher = state.build_hasher();
    hasher.write_u64(lane);
    hasher.write_u64(a);
    hasher.write_u64(b);
    hasher.finish()
}

/// Byte positions (with offset inside their digit run) that the per-iteration
/// rotation rewrites: every digit run immediately preceded by an ASCII
/// letter, or by `-` right after a letter (CSS idents). These runs always sit
/// inside identifier-shaped tokens or trivia, never in standalone numeric
/// literals, so rewriting them can never change token kinds, lengths, or
/// positions.
fn rotation_positions(base: &str) -> Vec<(u32, u8)> {
    let mut positions = Vec::new();
    let mut anchored = false;
    let mut previous_alpha = false;
    let mut run_offset = 0u8;
    for (index, &byte) in base.as_bytes().iter().enumerate() {
        if byte.is_ascii_digit() {
            if anchored {
                positions.push((index as u32, run_offset));
            }
            run_offset = run_offset.saturating_add(1);
            previous_alpha = false;
        } else {
            anchored = byte.is_ascii_alphabetic() || (byte == b'-' && previous_alpha);
            previous_alpha = byte.is_ascii_alphabetic();
            run_offset = 0;
        }
    }
    positions
}

/// Build the identity-distinct source for one timed iteration by rotating the
/// digits at every anchored position. Offsets come from the base-9 digits of
/// `iteration - 1`, indexed by the position inside the run, so the map is one
/// fixed digit bijection per iteration: distinct names stay distinct (no new
/// duplicate declarations), identical names rotate consistently, and base-9
/// uniqueness makes every iteration's source differ from the base and from
/// every other iteration. Token kinds, lengths, and byte positions are all
/// preserved, so the tree fingerprint of a rotated source must equal the
/// protected baseline value while a cached tree replayed across iterations
/// fails the text probes.
fn rotate_digits(base: &str, iteration: usize, positions: &[(u32, u8)]) -> Result<String, String> {
    if iteration == 0 || positions.is_empty() {
        return Err("rotation requires a positive iteration and eligible digits".to_string());
    }
    let mut out = base.as_bytes().to_vec();
    for &(position, run_offset) in positions {
        let mut quotient = iteration - 1;
        for _ in 0..run_offset {
            quotient /= 9;
        }
        let rotation = 1 + (quotient % 9) as u8;
        let byte = out[position as usize];
        out[position as usize] = b'0' + (byte - b'0' + rotation) % 10;
    }
    String::from_utf8(out).map_err(|_| "input rotation broke UTF-8".to_string())
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

/// One uniform-probe record captured from the baseline iteration: raw token
/// kind plus full (trivia-inclusive) range at a process-random byte offset.
struct ProbeRecord {
    kind: u16,
    start: u32,
    len: u32,
}

/// Resolve the token covering one byte via binary-search descent over the
/// pinned green tree (`covering_element` uses `slot_at_range`), so a probe
/// costs O(depth * log fanout) and validation stays negligible next to the
/// parse itself.
fn token_at_byte<L: Language>(root: &SyntaxNode<L>, position: u32) -> Result<SyntaxToken<L>, String> {
    root.covering_element(TextRange::new(
        TextSize::from(position),
        TextSize::from(position + 1),
    ))
    .into_token()
    .ok_or_else(|| "probe position is not covered by a token".to_string())
}

/// Shared parse-benchmark loop. Iteration 0 parses the frozen base source and
/// supplies the receipt values (fingerprint, element count, ranges,
/// diagnostics), so the receipt stays byte-identical to the protected oracle
/// and binds the baseline tree to the frozen input. Every later iteration
/// parses a rotated, identity-distinct source so repeated timed work cannot
/// be served from a cache keyed on input content, and is validated by cheap
/// probes so the measured per-iteration workload stays the plain uncached
/// parse:
/// - rotated-position probes (fresh entropy each iteration) reject any tree
///   whose text was not produced from THIS iteration's source;
/// - uniform-offset probes (process entropy, unknown at candidate build
///   time) pin token kind/range shape to the baseline tree and token text to
///   this iteration's source;
/// - diagnostic count and root ranges must match the baseline;
/// - one entropy-chosen iteration additionally gets the complete text
///   equality walk.
/// Only one parse tree is ever live, matching the baseline peak RSS profile
/// of an uncached one-shot parse.
fn timed_parse_iterations<L: Language, F>(
    code: &str,
    repetitions: usize,
    parse: F,
) -> Result<(u32, u64, u64, String), String>
where
    F: Fn(&str, bool) -> (SyntaxNode<L>, usize, Option<String>),
{
    let positions = rotation_positions(code);
    if repetitions > 1 && positions.is_empty() {
        return Err("frozen input exposes no rotation-eligible digits".to_string());
    }
    let entropy = RandomState::new();
    let deep_iteration = if repetitions > 1 {
        1 + (entropy_draw(&entropy, 0, 0, 0) % (repetitions as u64 - 1)) as usize
    } else {
        0
    };
    let uniform_offsets: Vec<u32> = (0..UNIFORM_PROBES)
        .map(|probe| (entropy_draw(&entropy, 1, probe as u64, 0) % code.len() as u64) as u32)
        .collect();
    let mut baseline: Option<(u32, u64, u64, usize, String, Vec<ProbeRecord>)> = None;
    for iteration in 0..repetitions {
        let rotated;
        let source: &str = if iteration == 0 {
            code
        } else {
            rotated = rotate_digits(code, iteration, &positions)?;
            &rotated
        };
        let (root, diagnostic_count, diagnostics) = parse(source, iteration == 0);
        if u32::from(root.text_with_trivia().len()) as usize != source.len() {
            return Err("iteration tree length does not match its input source".to_string());
        }
        let range = u32::from(root.text_trimmed_range().len());
        match &baseline {
            None => {
                // The baseline tree needs no text walk here: its fingerprint,
                // ranges, and diagnostics feed the receipt the trusted
                // evaluator checks against the protected oracle, which binds
                // this tree to the frozen input already.
                let (fingerprint, elements) = tree_fingerprint(&root);
                let mut records = Vec::with_capacity(uniform_offsets.len());
                for &offset in &uniform_offsets {
                    let token = token_at_byte(&root, offset)?;
                    let token_range = token.text_range();
                    records.push(ProbeRecord {
                        kind: token.kind().to_raw().0,
                        start: u32::from(token_range.start()),
                        len: u32::from(token_range.len()),
                    });
                }
                let diagnostics = diagnostics
                    .ok_or_else(|| "baseline iteration is missing diagnostics".to_string())?;
                baseline = Some((
                    range,
                    fingerprint,
                    elements,
                    diagnostic_count,
                    diagnostics,
                    records,
                ));
            }
            Some((base_range, _, _, base_count, _, records)) => {
                if *base_range != range || *base_count != diagnostic_count {
                    return Err(
                        "iteration tree diverges from the baseline iteration".to_string()
                    );
                }
                let source_bytes = source.as_bytes();
                for probe in 0..ROTATED_PROBES {
                    let pick = entropy_draw(&entropy, 2, iteration as u64, probe as u64)
                        % positions.len() as u64;
                    let (position, _) = positions[pick as usize];
                    let token = token_at_byte(&root, position)?;
                    let relative = (position - u32::from(token.text_range().start())) as usize;
                    if token.text().as_bytes().get(relative).copied()
                        != Some(source_bytes[position as usize])
                    {
                        return Err(
                            "iteration tree does not reproduce its own rotated input".to_string()
                        );
                    }
                }
                for (record, &offset) in records.iter().zip(&uniform_offsets) {
                    let token = token_at_byte(&root, offset)?;
                    let token_range = token.text_range();
                    if token.kind().to_raw().0 != record.kind
                        || u32::from(token_range.start()) != record.start
                        || u32::from(token_range.len()) != record.len
                        || token.text().as_bytes()
                            != &source_bytes
                                [record.start as usize..(record.start + record.len) as usize]
                    {
                        return Err(
                            "iteration tree diverges from the baseline at a probe".to_string()
                        );
                    }
                }
                // One entropy-chosen iteration gets the complete text
                // equality walk: a tree recycled from another iteration and
                // patched only at probed positions still fails here, so
                // passing every iteration requires text-faithful trees
                // throughout. Shape is already pinned per-iteration by the
                // uniform probes; a second fingerprint walk would only
                // re-check what the probes and the receipt cover, at real
                // wall-clock cost.
                if iteration == deep_iteration && root.text_with_trivia() != source {
                    return Err(
                        "iteration tree does not reproduce its own input source".to_string()
                    );
                }
            }
        }
    }
    let (range, fingerprint, elements, _, diagnostics, _) =
        baseline.ok_or_else(|| "repetitions must be positive".to_string())?;
    Ok((range, fingerprint, elements, diagnostics))
}

/// Parse benchmark: repeat the full uncached parse over per-iteration
/// identity-distinct sources, then bind completion by writing a receipt
/// derived from the baseline iteration's tree and diagnostics. This binary
/// never reports timing; the trusted evaluator measures wall time around the
/// whole process.
fn bench_parse(path: &Path, repetitions: usize, receipt: &Path) -> Result<(), String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    let (range, fingerprint, elements, diagnostics) =
        if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
            timed_parse_iterations(&code, repetitions, |source, want_diagnostics| {
                let parsed = black_box(parse_css(
                    black_box(source),
                    CssFileSource::css(),
                    CssParserOptions::default(),
                ));
                let diagnostic_count = parsed.diagnostics().len();
                let diagnostics =
                    want_diagnostics.then(|| format!("{:?}", parsed.diagnostics()));
                (parsed.syntax(), diagnostic_count, diagnostics)
            })?
        } else {
            let source_kind = js_source(path);
            timed_parse_iterations(&code, repetitions, |source, want_diagnostics| {
                let parsed = black_box(parse_js(
                    black_box(source),
                    source_kind,
                    JsParserOptions::default(),
                ));
                let diagnostic_count = parsed.diagnostics().len();
                let diagnostics =
                    want_diagnostics.then(|| format!("{:?}", parsed.diagnostics()));
                (parsed.syntax(), diagnostic_count, diagnostics)
            })?
        };
    write_parse_receipt(receipt, range, fingerprint, elements, &diagnostics)
}

/// Collect tokens usable for per-iteration format-input rotation: identifier-
/// shaped tokens ending in at least three digits (the generated corpora name
/// everything `name{n}` / `component-{n}`), with only whitespace/newline
/// trivia so trivia reattachment is loss-free and formatter comment handling
/// stays untouched.
fn rotation_targets<L: Language>(root: &SyntaxNode<L>) -> Vec<SyntaxToken<L>> {
    root.descendants_with_tokens(Direction::Next)
        .filter_map(|element| element.into_token())
        .filter(|token| {
            let bytes = token.text_trimmed().as_bytes();
            let digits = bytes
                .iter()
                .rev()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            digits >= 3
                && digits < bytes.len()
                && bytes[0].is_ascii_alphabetic()
                && bytes
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-' || *byte == b'_')
                && token
                    .leading_trivia()
                    .pieces()
                    .all(|piece| piece.is_whitespace() || piece.is_newline())
                && token
                    .trailing_trivia()
                    .pieces()
                    .all(|piece| piece.is_whitespace() || piece.is_newline())
        })
        .collect()
}

/// Same-length replacement text for a rotation target: the identifier stem is
/// kept (so name-based and width-based formatter heuristics cannot move) and
/// the trailing digits become keyed lowercase letters, giving each iteration
/// a distinct token spelling that cannot occur anywhere else in the output.
fn rotated_token_text(trimmed: &str, iteration: usize, attempt: usize) -> String {
    let bytes = trimmed.as_bytes();
    let digits = bytes
        .iter()
        .rev()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    let stem = bytes.len() - digits;
    let mut text = String::with_capacity(bytes.len());
    text.push_str(&trimmed[..stem]);
    let mut hash = FNV_OFFSET;
    fnv_mix(&mut hash, iteration as u64);
    fnv_mix(&mut hash, attempt as u64);
    for &byte in &bytes[stem..] {
        fnv_mix(&mut hash, u64::from(byte));
        text.push(char::from(b'a' + (hash % 26) as u8));
    }
    text
}

/// Shared format-benchmark loop. Iteration 0 formats the unmodified base tree
/// and its output becomes the receipt (byte-identical to the protected
/// oracle). Every later iteration formats a freshly built tree in which one
/// scheduled identifier token is swapped for a same-kind, same-length,
/// iteration-unique spelling via pinned-rowan green-tree surgery, so repeated
/// timed work cannot be served from a cache keyed on tree identity or
/// content. Each rotated output is validated against the oracle-bound base
/// output: same byte length, the unique spelling appears exactly once, and
/// substituting the original spelling back reproduces the base output
/// exactly.
fn timed_format_iterations<L: Language, F>(
    root: &SyntaxNode<L>,
    repetitions: usize,
    format: F,
) -> Result<String, String>
where
    F: Fn(&SyntaxNode<L>) -> Result<String, String>,
{
    let base_printed = format(black_box(root))?;
    if repetitions > 1 {
        let targets = rotation_targets(root);
        if targets.is_empty() {
            return Err("frozen input exposes no rotation-eligible tokens".to_string());
        }
        for iteration in 1..repetitions {
            let mut selected = None;
            'probe: for probe in 0..targets.len() {
                let token = &targets[(iteration - 1 + probe) % targets.len()];
                let original = token.text_trimmed();
                for attempt in 0..4usize {
                    let replacement = rotated_token_text(original, iteration, attempt);
                    if !base_printed.contains(&replacement) {
                        selected = Some((token, original, replacement));
                        break 'probe;
                    }
                }
            }
            let (token, original, replacement) = selected
                .ok_or_else(|| "no usable rotation token for this iteration".to_string())?;
            let no_trivia: [TriviaPiece; 0] = [];
            let rotated_token =
                SyntaxToken::new_detached(token.kind(), &replacement, no_trivia, no_trivia)
                    .with_leading_trivia_pieces(token.leading_trivia().pieces())
                    .with_trailing_trivia_pieces(token.trailing_trivia().pieces());
            let rotated_root = root
                .clone()
                .replace_child(token.clone().into(), rotated_token.into())
                .ok_or_else(|| "token rotation lost track of its target".to_string())?;
            let printed = format(black_box(&rotated_root))?;
            if printed.len() != base_printed.len()
                || printed.matches(replacement.as_str()).count() != 1
                || printed.replacen(replacement.as_str(), original, 1) != base_printed
            {
                return Err(
                    "iteration format output does not correspond to its rotated input".to_string()
                );
            }
        }
    }
    Ok(base_printed)
}

/// Format benchmark: parse once, then repeat format+print over per-iteration
/// identity-distinct trees, binding completion by writing the baseline
/// iteration's printed output. The trusted evaluator checks the receipt bytes
/// against the protected byte-exact formatting oracle.
fn bench_format(path: &Path, repetitions: usize, receipt: &Path) -> Result<(), String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    let printed_code = if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
        let parsed = parse_css(&code, CssFileSource::css(), CssParserOptions::default());
        let root = parsed.tree().into_syntax();
        if root.text_with_trivia() != code.as_str() {
            return Err("parsed tree does not reproduce the frozen input".to_string());
        }
        timed_format_iterations(&root, repetitions, |node| {
            format_css_node(CssFormatOptions::default(), node)
                .map_err(|err| format!("CSS format failed: {err}"))?
                .print()
                .map_err(|err| format!("CSS print failed: {err}"))
                .map(|printed| printed.into_code())
        })?
    } else {
        let parsed = parse_js(&code, js_source(path), JsParserOptions::default());
        let root = parsed.tree().into_syntax();
        if root.text_with_trivia() != code.as_str() {
            return Err("parsed tree does not reproduce the frozen input".to_string());
        }
        timed_format_iterations(&root, repetitions, |node| {
            format_js_node(JsFormatOptions::default(), node, Vec::new())
                .map_err(|err| format!("JS format failed: {err}"))?
                .print()
                .map_err(|err| format!("JS print failed: {err}"))
                .map(|printed| printed.into_code())
        })?
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
