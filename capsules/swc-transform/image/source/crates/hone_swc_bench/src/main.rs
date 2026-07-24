use std::{
    env,
    error::Error,
    fs,
    path::Path,
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use swc_common::{
    comments::SingleThreadedComments, sync::Lrc, FileName, Globals, Mark, SourceMap, GLOBALS,
};
use swc_ecma_ast::{EsVersion, Program};
use swc_ecma_codegen::to_code_default;
use swc_ecma_parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax, TsSyntax};
use swc_ecma_transforms_base::{fixer::fixer, resolver};
use swc_ecma_transforms_react as react;
use swc_ecma_transforms_typescript as typescript;

/// Timed-mode widening: each `bench` invocation performs the pristine
/// parse+transform plus this many identity-rotated repetitions. Every
/// rotation appends a unique trailing line comment, so each iteration lexes
/// distinct bytes (no content-identical replay) while the semantic AST and
/// the emitted code must stay byte-identical to the pristine iteration.
const BENCH_ROTATIONS: usize = 16;

#[derive(Clone, Copy)]
enum WorkloadKind {
    JavaScript,
    TypeScript,
    Tsx,
}

impl WorkloadKind {
    fn parse(value: &str) -> Result<Self, Box<dyn Error>> {
        match value {
            "js" => Ok(Self::JavaScript),
            "ts" => Ok(Self::TypeScript),
            "tsx" => Ok(Self::Tsx),
            _ => Err(format!("unsupported workload kind: {value}").into()),
        }
    }
}

struct Workload {
    id: String,
    kind: WorkloadKind,
    source: String,
    source_hash: String,
}

struct Transformed {
    program: Program,
    source_map: Lrc<SourceMap>,
}

fn syntax(kind: WorkloadKind) -> Syntax {
    match kind {
        WorkloadKind::JavaScript => Syntax::Es(EsSyntax {
            decorators: true,
            decorators_before_export: true,
            export_default_from: true,
            import_attributes: true,
            auto_accessors: true,
            ..Default::default()
        }),
        WorkloadKind::TypeScript => Syntax::Typescript(TsSyntax {
            decorators: true,
            ..Default::default()
        }),
        WorkloadKind::Tsx => Syntax::Typescript(TsSyntax {
            tsx: true,
            decorators: true,
            ..Default::default()
        }),
    }
}

fn parse_program(
    source_map: &Lrc<SourceMap>,
    source: &str,
    syntax: Syntax,
    comments: &SingleThreadedComments,
) -> Result<Program, Box<dyn Error>> {
    let file = source_map.new_source_file(
        FileName::Custom("hone-workload.js".into()).into(),
        source.to_owned(),
    );
    let lexer = Lexer::new(
        syntax,
        EsVersion::latest(),
        StringInput::from(&*file),
        Some(comments),
    );
    let mut parser = Parser::new_from(lexer);
    let program = parser
        .parse_program()
        .map_err(|error| format!("parse failed: {error:?}"))?;
    let recovered = parser.take_errors();
    if !recovered.is_empty() {
        return Err(format!("parser recovered from {} errors", recovered.len()).into());
    }
    Ok(program)
}

fn parse_and_transform(source: &str, kind: WorkloadKind) -> Result<Transformed, Box<dyn Error>> {
    let source_map: Lrc<SourceMap> = Default::default();
    let comments = SingleThreadedComments::default();
    let program = parse_program(&source_map, source, syntax(kind), &comments)?;
    let globals = Globals::default();
    let program = GLOBALS.set(&globals, || {
        let unresolved_mark = Mark::new();
        let top_level_mark = Mark::new();
        match kind {
            WorkloadKind::JavaScript => program
                .apply(resolver(unresolved_mark, top_level_mark, false))
                .apply(fixer(None)),
            WorkloadKind::TypeScript => program
                .apply(resolver(unresolved_mark, top_level_mark, true))
                .apply(typescript::typescript(
                    typescript::Config {
                        no_empty_export: true,
                        ..Default::default()
                    },
                    unresolved_mark,
                    top_level_mark,
                ))
                .apply(fixer(None)),
            WorkloadKind::Tsx => program
                .apply(resolver(unresolved_mark, top_level_mark, true))
                .apply(typescript::tsx(
                    source_map.clone(),
                    typescript::Config {
                        no_empty_export: true,
                        ..Default::default()
                    },
                    typescript::TsxConfig::default(),
                    comments.clone(),
                    unresolved_mark,
                    top_level_mark,
                ))
                .apply(react::jsx(
                    source_map.clone(),
                    Some(comments.clone()),
                    react::Options::default(),
                    top_level_mark,
                    unresolved_mark,
                ))
                .apply(fixer(None)),
        }
    });
    Ok(Transformed {
        program,
        source_map,
    })
}

fn scrub_semantic_noise(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(scrub_semantic_noise),
        Value::Object(values) => {
            values.remove("span");
            values.remove("raw");
            values.values_mut().for_each(scrub_semantic_noise);
        }
        _ => {}
    }
}

fn semantic_hash(program: &Program) -> Result<String, Box<dyn Error>> {
    let mut value = serde_json::to_value(program)?;
    scrub_semantic_noise(&mut value);
    Ok(hex_hash(serde_json::to_vec(&value)?))
}

fn hex_hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

fn emitted_output_hash(output: &str) -> Result<String, Box<dyn Error>> {
    let output_map: Lrc<SourceMap> = Default::default();
    let output_comments = SingleThreadedComments::default();
    let output_program = parse_program(
        &output_map,
        output,
        Syntax::Es(EsSyntax {
            decorators: true,
            decorators_before_export: true,
            export_default_from: true,
            import_attributes: true,
            auto_accessors: true,
            ..Default::default()
        }),
        &output_comments,
    )?;
    semantic_hash(&output_program)
}


fn verify_workload(workload: &Workload) -> Result<Value, Box<dyn Error>> {
    let transformed = parse_and_transform(&workload.source, workload.kind)?;
    let ast_hash = semantic_hash(&transformed.program)?;
    let output = to_code_default(transformed.source_map, None, &transformed.program);
    let output_hash = emitted_output_hash(&output)?;
    Ok(json!({
        "id": workload.id,
        "sourceSha256": workload.source_hash,
        "astSemanticSha256": ast_hash,
        "outputSemanticSha256": output_hash,
        "outputBytes": output.len(),
        "outputCode": output,
    }))
}


fn bench_workload(source: &str, kind: WorkloadKind) -> Result<(), Box<dyn Error>> {
    let pristine = parse_and_transform(source, kind)?;
    let expected = to_code_default(pristine.source_map, None, &pristine.program);
    if expected.is_empty() {
        return Err("bench emitted empty output".into());
    }
    for iteration in 1..=BENCH_ROTATIONS {
        let rotated = format!("{source}\n//hone-rot-{iteration:04}");
        let transformed = parse_and_transform(&rotated, kind)?;
        let output = to_code_default(transformed.source_map, None, &transformed.program);
        if output != expected {
            return Err(
                format!("identity-rotated iteration {iteration} diverged from pristine output").into(),
            );
        }
    }
    Ok(())
}

fn selftest() -> Result<(), Box<dyn Error>> {
    for (kind, source) in [
        (WorkloadKind::JavaScript, "export const value = ({ a: 1 })?.a ?? 0;"),
        (WorkloadKind::TypeScript, "interface Row { value: number } export const row: Row = { value: 1 };"),
        (WorkloadKind::Tsx, "type P = { name: string }; export const View = (p: P) => <main>{p.name}</main>;"),
    ] {
        let transformed = parse_and_transform(source, kind)?;
        let output = to_code_default(transformed.source_map, None, &transformed.program);
        if output.is_empty() {
            return Err("transform self-test emitted empty output".into());
        }
    }
    println!("selftest: 3 parse+transform cases passed");
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("selftest") if args.len() == 2 => selftest(),
        Some("once") if args.len() == 4 => {
            let path = Path::new(&args[2]);
            let bytes = fs::read(path)?;
            let source_hash = hex_hash(&bytes);
            let workload = Workload {
                id: "sealed".to_owned(),
                kind: WorkloadKind::parse(&args[3])?,
                source: String::from_utf8(bytes)?,
                source_hash,
            };
            println!("{}", serde_json::to_string(&verify_workload(&workload)?)?);
            Ok(())
        }
        Some("bench") if args.len() == 4 => {
            let path = Path::new(&args[2]);
            let bytes = fs::read(path)?;
            let source_hash = hex_hash(&bytes);
            let kind = WorkloadKind::parse(&args[3])?;
            let source = String::from_utf8(bytes)?;
            bench_workload(&source, kind)?;
            let workload = Workload {
                id: "sealed".to_owned(),
                kind,
                source,
                source_hash,
            };
            println!("{}", serde_json::to_string(&verify_workload(&workload)?)?);
            Ok(())
        }
        Some("output-hash") if args.len() == 3 => {
            let output = fs::read_to_string(&args[2])?;
            println!("{}", emitted_output_hash(&output)?);
            Ok(())
        }
        _ => Err(format!(
            "usage: {} selftest | once SOURCE KIND | bench SOURCE KIND | output-hash OUTPUT",
            args.first().map(String::as_str).unwrap_or("hone-swc-bench")
        )
        .into()),
    }
}
