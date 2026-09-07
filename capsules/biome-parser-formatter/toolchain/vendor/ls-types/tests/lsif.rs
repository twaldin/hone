#[test]
#[cfg(unix)]
fn run() {
    use ls_types::lsif::Entry;

    let jsonl = include_str!("tsc-unix.lsif");
    for json in jsonl.lines() {
        let entry =
            serde_json::from_str::<Entry>(json).unwrap_or_else(|_| panic!("can not parse {json}"));
        let serialized =
            serde_json::to_string(&entry).unwrap_or_else(|_| panic!("can not serialize {json}"));

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&serialized).unwrap(),
            serde_json::from_str::<serde_json::Value>(json).unwrap(),
            "and strings:\ntheir: {json}\n  our: {serialized}",
        );
    }
}
