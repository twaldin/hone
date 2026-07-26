use biome_css_formatter::{context::CssFormatOptions, format_node as format_css_node};
use biome_css_parser::{CssParserOptions, parse_css};
use biome_js_formatter::{context::JsFormatOptions, format_node as format_js_node};
use biome_js_parser::{JsParserOptions, parse as parse_js};
use biome_languages::{CssFileSource, JsFileSource};
use biome_rowan::{
    AstNode, Direction, Language, SyntaxNode, SyntaxToken, SyntaxKind, TextRange, TextSize,
    TriviaPiece,
};
use std::env;
use std::fs;
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

fn fnv_bytes(hash: &mut u64, bytes: &[u8]) {
    for &byte in bytes {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

/// Deterministic per-sample draw seeded from the trusted parent's fresh
/// per-sample nonce. The candidate and the pristine reference runner are both
/// driven with the same nonce, so their probe offsets, deep-check iteration,
/// and accumulated proof coincide only when both actually executed every
/// timed iteration over the pinned parser output. The nonce is chosen by the
/// trusted parent at run time, so no build-time constant can precompute it.
fn nonce_draw(nonce: u64, lane: u64, a: u64, b: u64) -> u64 {
    let mut hash = FNV_OFFSET;
    fnv_mix(&mut hash, nonce);
    fnv_mix(&mut hash, lane);
    fnv_mix(&mut hash, a);
    fnv_mix(&mut hash, b);
    hash
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
/// captures the fingerprint, element count, ranges, and diagnostics; every
/// later iteration parses a rotated, identity-distinct source so repeated
/// timed work cannot be served from a cache keyed on input content, and is
/// validated by cheap probes so the measured per-iteration workload stays the
/// plain uncached parse:
/// - rotated-position probes (nonce-seeded each iteration) reject any tree
///   whose text was not produced from THIS iteration's source;
/// - uniform-offset probes (nonce-seeded, unknown at candidate build time)
///   pin token kind/range shape to the baseline tree and token text to this
///   iteration's source;
/// - diagnostic count and root ranges must match the baseline;
/// - one nonce-chosen iteration additionally gets the complete text walk.
/// Only one parse tree is ever live, matching the baseline peak RSS profile
/// of an uncached one-shot parse. Instead of a candidate-writable completion
/// file, the loop folds every iteration's protected probe observations into a
/// running proof keyed by the parent nonce and returns it. The trusted parent
/// requires this proof to equal the pristine reference runner's proof for the
/// same nonce, so a process that skipped iterations (e.g. computed the base
/// tree once and exited) cannot produce an accepted sample.
fn timed_parse_iterations<L: Language, F>(
    code: &str,
    repetitions: usize,
    nonce: u64,
    parse: F,
) -> Result<u64, String>
where
    F: Fn(&str, bool) -> (SyntaxNode<L>, usize, Option<String>),
{
    let positions = rotation_positions(code);
    if repetitions > 1 && positions.is_empty() {
        return Err("frozen input exposes no rotation-eligible digits".to_string());
    }
    let deep_iteration = if repetitions > 1 {
        1 + (nonce_draw(nonce, 0, 0, 0) % (repetitions as u64 - 1)) as usize
    } else {
        0
    };
    let uniform_offsets: Vec<u32> = (0..UNIFORM_PROBES)
        .map(|probe| (nonce_draw(nonce, 1, probe as u64, 0) % code.len() as u64) as u32)
        .collect();
    let mut proof = FNV_OFFSET;
    fnv_mix(&mut proof, nonce);
    fnv_mix(&mut proof, repetitions as u64);
    let mut baseline: Option<(u32, usize, Vec<ProbeRecord>)> = None;
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
                let (fingerprint, elements) = tree_fingerprint(&root);
                let mut records = Vec::with_capacity(uniform_offsets.len());
                for &offset in &uniform_offsets {
                    let token = token_at_byte(&root, offset)?;
                    let token_range = token.text_range();
                    let record = ProbeRecord {
                        kind: token.kind().to_raw().0,
                        start: u32::from(token_range.start()),
                        len: u32::from(token_range.len()),
                    };
                    fnv_mix(&mut proof, u64::from(record.kind));
                    fnv_mix(&mut proof, u64::from(record.start));
                    fnv_mix(&mut proof, u64::from(record.len));
                    fnv_bytes(&mut proof, token.text().as_bytes());
                    records.push(record);
                }
                let diagnostics = diagnostics
                    .ok_or_else(|| "baseline iteration is missing diagnostics".to_string())?;
                fnv_mix(&mut proof, u64::from(range));
                fnv_mix(&mut proof, fingerprint);
                fnv_mix(&mut proof, elements);
                fnv_mix(&mut proof, diagnostic_count as u64);
                fnv_bytes(&mut proof, diagnostics.as_bytes());
                baseline = Some((range, diagnostic_count, records));
            }
            Some((base_range, base_count, records)) => {
                if *base_range != range || *base_count != diagnostic_count {
                    return Err(
                        "iteration tree diverges from the baseline iteration".to_string()
                    );
                }
                fnv_mix(&mut proof, iteration as u64);
                let source_bytes = source.as_bytes();
                for probe in 0..ROTATED_PROBES {
                    let pick = nonce_draw(nonce, 2, iteration as u64, probe as u64)
                        % positions.len() as u64;
                    let (position, _) = positions[pick as usize];
                    let token = token_at_byte(&root, position)?;
                    let relative = (position - u32::from(token.text_range().start())) as usize;
                    let observed = token.text().as_bytes().get(relative).copied();
                    if observed != Some(source_bytes[position as usize]) {
                        return Err(
                            "iteration tree does not reproduce its own rotated input".to_string()
                        );
                    }
                    fnv_mix(&mut proof, u64::from(position));
                    fnv_mix(&mut proof, u64::from(source_bytes[position as usize]));
                }
                for (record, &offset) in records.iter().zip(&uniform_offsets) {
                    let token = token_at_byte(&root, offset)?;
                    let token_range = token.text_range();
                    let text = token.text();
                    if token.kind().to_raw().0 != record.kind
                        || u32::from(token_range.start()) != record.start
                        || u32::from(token_range.len()) != record.len
                        || text.as_bytes()
                            != &source_bytes
                                [record.start as usize..(record.start + record.len) as usize]
                    {
                        return Err(
                            "iteration tree diverges from the baseline at a probe".to_string()
                        );
                    }
                    fnv_bytes(&mut proof, text.as_bytes());
                }
                if iteration == deep_iteration && root.text_with_trivia() != source {
                    return Err(
                        "iteration tree does not reproduce its own input source".to_string()
                    );
                }
            }
        }
    }
    if baseline.is_none() {
        return Err("repetitions must be positive".to_string());
    }
    Ok(proof)
}

/// Parse benchmark: repeat the full uncached parse over per-iteration
/// identity-distinct sources and return the nonce-keyed proof folded from
/// every iteration's protected probe observations. This binary never reports
/// timing; the trusted evaluator measures wall time around the whole process
/// and cross-checks the proof against the pristine reference runner.
fn bench_parse(path: &Path, repetitions: usize, nonce: u64) -> Result<u64, String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
        timed_parse_iterations(&code, repetitions, nonce, |source, want_diagnostics| {
            let parsed = black_box(parse_css(
                black_box(source),
                CssFileSource::css(),
                CssParserOptions::default(),
            ));
            let diagnostic_count = parsed.diagnostics().len();
            let diagnostics = want_diagnostics.then(|| format!("{:?}", parsed.diagnostics()));
            (parsed.syntax(), diagnostic_count, diagnostics)
        })
    } else {
        let source_kind = js_source(path);
        timed_parse_iterations(&code, repetitions, nonce, |source, want_diagnostics| {
            let parsed = black_box(parse_js(
                black_box(source),
                source_kind,
                JsParserOptions::default(),
            ));
            let diagnostic_count = parsed.diagnostics().len();
            let diagnostics = want_diagnostics.then(|| format!("{:?}", parsed.diagnostics()));
            (parsed.syntax(), diagnostic_count, diagnostics)
        })
    }
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

/// Shared format-benchmark loop. Iteration 0 formats the unmodified base tree;
/// every later iteration formats a freshly built tree in which one nonce-
/// scheduled identifier token is swapped for a same-kind, same-length,
/// iteration-unique spelling via pinned-rowan green-tree surgery, so repeated
/// timed work cannot be served from a cache keyed on tree identity or
/// content. Each rotated output is validated against the base output (same
/// byte length, the unique spelling appears exactly once, and substituting the
/// original spelling back reproduces the base output exactly), and every
/// iteration's replacement plus printed bytes are folded into a nonce-keyed
/// proof. The trusted parent requires the returned proof to equal the pristine
/// reference runner's proof for the same nonce, so a process that formatted the
/// base once and exited cannot produce an accepted sample.
fn timed_format_iterations<L: Language, F>(
    root: &SyntaxNode<L>,
    repetitions: usize,
    nonce: u64,
    format: F,
) -> Result<u64, String>
where
    F: Fn(&SyntaxNode<L>) -> Result<String, String>,
{
    let base_printed = format(black_box(root))?;
    let mut proof = FNV_OFFSET;
    fnv_mix(&mut proof, nonce);
    fnv_mix(&mut proof, repetitions as u64);
    fnv_mix(&mut proof, base_printed.len() as u64);
    fnv_bytes(&mut proof, base_printed.as_bytes());
    if repetitions > 1 {
        let targets = rotation_targets(root);
        if targets.is_empty() {
            return Err("frozen input exposes no rotation-eligible tokens".to_string());
        }
        for iteration in 1..repetitions {
            let start = (nonce_draw(nonce, 4, iteration as u64, 0) % targets.len() as u64) as usize;
            let mut selected = None;
            'probe: for probe in 0..targets.len() {
                let token = &targets[(start + probe) % targets.len()];
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
            fnv_mix(&mut proof, iteration as u64);
            fnv_bytes(&mut proof, replacement.as_bytes());
            fnv_mix(&mut proof, printed.len() as u64);
            fnv_bytes(&mut proof, printed.as_bytes());
        }
    }
    Ok(proof)
}

/// Format benchmark: parse once, then repeat format+print over per-iteration
/// identity-distinct trees and return the nonce-keyed proof. The trusted
/// evaluator measures wall time around the whole process and cross-checks the
/// proof against the pristine reference runner.
fn bench_format(path: &Path, repetitions: usize, nonce: u64) -> Result<u64, String> {
    let code = fs::read_to_string(path).map_err(|err| format!("read failed: {err}"))?;
    if path.extension().and_then(|ext| ext.to_str()) == Some("css") {
        let parsed = parse_css(&code, CssFileSource::css(), CssParserOptions::default());
        let root = parsed.tree().into_syntax();
        if root.text_with_trivia() != code.as_str() {
            return Err("parsed tree does not reproduce the frozen input".to_string());
        }
        timed_format_iterations(&root, repetitions, nonce, |node| {
            format_css_node(CssFormatOptions::default(), node)
                .map_err(|err| format!("CSS format failed: {err}"))?
                .print()
                .map_err(|err| format!("CSS print failed: {err}"))
                .map(|printed| printed.into_code())
        })
    } else {
        let parsed = parse_js(&code, js_source(path), JsParserOptions::default());
        let root = parsed.tree().into_syntax();
        if root.text_with_trivia() != code.as_str() {
            return Err("parsed tree does not reproduce the frozen input".to_string());
        }
        timed_format_iterations(&root, repetitions, nonce, |node| {
            format_js_node(JsFormatOptions::default(), node, Vec::new())
                .map_err(|err| format!("JS format failed: {err}"))?
                .print()
                .map_err(|err| format!("JS print failed: {err}"))
                .map(|printed| printed.into_code())
        })
    }
}

const SELFTEST_CHECKS: [&str; 6] = [
    "js-valid",
    "js-recovery",
    "js-format",
    "css-valid",
    "css-recovery",
    "css-format",
];

/// Fold nonce-selected structural probes of one parse-based regression check
/// into the running proof. The check body still runs in full and asserts its
/// grammar expectation; the proof then binds the produced tree's fingerprint,
/// element and diagnostic counts, trimmed range, and UNIFORM_PROBES
/// nonce-selected token shape+text observations. The trusted parent draws the
/// nonce at run time and requires the candidate proof to equal the pristine
/// reference runner's proof for the same nonce, so a candidate broken on a
/// selftest-only construct — or one precomputing a fixed receipt offline —
/// cannot match.
fn fold_parse_probe<L: Language>(
    proof: &mut u64,
    lane: u64,
    nonce: u64,
    source: &str,
    root: &SyntaxNode<L>,
    diagnostic_count: usize,
) -> Result<(), String> {
    if u32::from(root.text_with_trivia().len()) as usize != source.len() {
        return Err("selftest tree length does not match its source".to_string());
    }
    let (fingerprint, elements) = tree_fingerprint(root);
    fnv_mix(proof, lane);
    fnv_mix(proof, u64::from(u32::from(root.text_trimmed_range().len())));
    fnv_mix(proof, fingerprint);
    fnv_mix(proof, elements);
    fnv_mix(proof, diagnostic_count as u64);
    let source_bytes = source.as_bytes();
    for probe in 0..UNIFORM_PROBES {
        let offset = (nonce_draw(nonce, lane, probe as u64, 0) % source.len() as u64) as u32;
        let token = token_at_byte(root, offset)?;
        let token_range = token.text_range();
        let start = u32::from(token_range.start());
        let len = u32::from(token_range.len());
        if token.text().as_bytes() != &source_bytes[start as usize..(start + len) as usize] {
            return Err("selftest probe token text diverges from its source".to_string());
        }
        fnv_mix(proof, u64::from(token.kind().to_raw().0));
        fnv_mix(proof, u64::from(start));
        fnv_mix(proof, u64::from(len));
        fnv_bytes(proof, token.text().as_bytes());
    }
    Ok(())
}

/// Fold nonce-selected byte probes of one formatter regression check's output
/// (already validated for exactness and idempotence) into the running proof.
/// The full output is folded so the proof binds every byte, and the
/// nonce-selected indices make the proof unpredictable at candidate build
/// time, so it cannot be precomputed offline and byte-replayed.
fn fold_format_probe(proof: &mut u64, lane: u64, nonce: u64, output: &str) {
    let bytes = output.as_bytes();
    fnv_mix(proof, lane);
    fnv_mix(proof, output.len() as u64);
    fnv_bytes(proof, bytes);
    for probe in 0..UNIFORM_PROBES {
        let index = (nonce_draw(nonce, lane, probe as u64, 1) % output.len() as u64) as usize;
        fnv_mix(proof, index as u64);
        fnv_mix(proof, u64::from(bytes[index]));
    }
}

/// Run one named regression check's full body, assert its grammar/formatter
/// expectation, and fold its nonce-selected structural probes into the proof.
fn selftest_fold(check: &str, lane: u64, nonce: u64, proof: &mut u64) -> Result<(), String> {
    match check {
        "js-valid" => {
            let source = "export function value<T>(input: T): T { return input; }\n";
            let parsed = parse_js(source, JsFileSource::ts(), JsParserOptions::default());
            if parsed.has_errors() {
                return Err(format!(
                    "upstream JS/TS valid-parse regression: {:?}",
                    parsed.diagnostics()
                ));
            }
            let syntax = parsed.syntax();
            fold_parse_probe(proof, lane, nonce, source, &syntax, parsed.diagnostics().len())
        }
        "js-recovery" => {
            let source = "export const broken = { value: };";
            let parsed = parse_js(source, JsFileSource::js_module(), JsParserOptions::default());
            if !parsed.has_errors() {
                return Err("upstream JS parser recovery regression".to_string());
            }
            let syntax = parsed.syntax();
            fold_parse_probe(proof, lane, nonce, source, &syntax, parsed.diagnostics().len())
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
            fold_format_probe(proof, lane, nonce, &once);
            Ok(())
        }
        "css-valid" => {
            let source = "@media (min-width: 40rem) { html { color: red; } }";
            let parsed = parse_css(source, CssFileSource::css(), CssParserOptions::default());
            if parsed.has_errors() {
                return Err(format!(
                    "upstream CSS valid-parse regression: {:?}",
                    parsed.diagnostics()
                ));
            }
            let syntax = parsed.syntax();
            fold_parse_probe(proof, lane, nonce, source, &syntax, parsed.diagnostics().len())
        }
        "css-recovery" => {
            let source = "html { color:";
            let parsed = parse_css(source, CssFileSource::css(), CssParserOptions::default());
            if !parsed.has_errors() {
                return Err("upstream CSS parser recovery regression".to_string());
            }
            let syntax = parsed.syntax();
            fold_parse_probe(proof, lane, nonce, source, &syntax, parsed.diagnostics().len())
        }
        "css-format" => {
            let (once, _) = format_css("html{}")?;
            let (twice, _) = format_css(&once)?;
            if once != "html {\n}\n" || once != twice {
                return Err("upstream CSS formatter exact/idempotence regression".to_string());
            }
            fold_format_probe(proof, lane, nonce, &once);
            Ok(())
        }
        _ => Err(format!("unknown selftest check: {check}")),
    }
}

/// Run every regression check under the parent-supplied nonce and return the
/// nonce-keyed proof folded from every check's protected structural probes.
/// This binary never decides pass/fail: the trusted parent draws the nonce,
/// drives BOTH this candidate runner and the pristine reference runner over
/// the same checks, and accepts the regression gate only when the two proofs
/// coincide — the same proof-vs-pristine-reference mechanism the benchmark
/// path uses, so the selftest gate is no longer a candidate-authored receipt
/// byte-compared to a frozen constant.
fn selftest_proof(nonce: u64) -> Result<u64, String> {
    let mut proof = FNV_OFFSET;
    fnv_mix(&mut proof, nonce);
    fnv_mix(&mut proof, SELFTEST_CHECKS.len() as u64);
    for (index, check) in SELFTEST_CHECKS.iter().enumerate() {
        selftest_fold(check, index as u64, nonce, &mut proof)?;
    }
    Ok(proof)
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    match args.as_slice() {
        [_, command] if command == "selftest" => {
            // Build-time smoke check: exercise every regression body once. The
            // scored gate always drives the nonce arm below with a fresh
            // parent-drawn nonce and cross-checks the proof against the
            // pristine reference runner.
            selftest_proof(0)?;
            Ok(())
        }
        [_, command, nonce] if command == "selftest" => {
            let nonce = nonce
                .parse::<u64>()
                .map_err(|_| "nonce must be an unsigned 64-bit integer".to_string())?;
            let proof = selftest_proof(nonce)?;
            println!("PROOF {proof:016x}");
            Ok(())
        }
        [_, command, input, output, second, diagnostics] if command == "verify" => verify(
            Path::new(input),
            Path::new(output),
            Path::new(second),
            Path::new(diagnostics),
        ),
        [_, command, input, repetitions, nonce] if command == "parse" || command == "format" => {
            let repetitions = repetitions
                .parse::<usize>()
                .map_err(|_| "repetitions must be a positive integer".to_string())?;
            if repetitions == 0 {
                return Err("repetitions must be positive".to_string());
            }
            let nonce = nonce
                .parse::<u64>()
                .map_err(|_| "nonce must be an unsigned 64-bit integer".to_string())?;
            let proof = if command == "parse" {
                bench_parse(Path::new(input), repetitions, nonce)?
            } else {
                bench_format(Path::new(input), repetitions, nonce)?
            };
            println!("PROOF {proof:016x}");
            Ok(())
        }
        _ => Err(
            "usage: hone_biome_bench selftest [NONCE] | verify INPUT OUTPUT SECOND DIAGNOSTICS | (parse|format) INPUT REPS NONCE"
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
