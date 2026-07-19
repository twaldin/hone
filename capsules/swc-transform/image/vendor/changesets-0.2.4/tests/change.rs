use changesets::{Change, ChangeType, UniqueId, Versioning};
use tempfile::tempdir;

#[test]
fn create_change() {
    let basic_programmatic = Change {
        unique_id: UniqueId::from("basic_programmatic"),
        versioning: Versioning::from(("my_package", ChangeType::Minor)),
        summary: String::from("### This is a summary"),
    };

    let multiple_packages = Change {
        unique_id: UniqueId::from("multiple_packages"),
        versioning: Versioning::try_from_iter([
            ("my_package", ChangeType::Minor),
            ("my_other_package", ChangeType::Major),
        ])
        .unwrap(),
        summary: String::from("### This is a summary"),
    };

    let dir = tempdir().unwrap();
    let basic_change_path = basic_programmatic.write_to_directory(&dir).unwrap();
    let multiple_change_path = multiple_packages.write_to_directory(&dir).unwrap();

    let contents = std::fs::read_to_string(basic_change_path).unwrap();
    assert_eq!(
        contents,
        "---\nmy_package: minor\n---\n\n### This is a summary\n"
    );

    let contents = std::fs::read_to_string(multiple_change_path).unwrap();
    // Order of packages is not guaranteed, they are semantically the same in YAML
    let first_possibility =
        "---\nmy_package: minor\nmy_other_package: major\n---\n\n### This is a summary\n";
    let second_possibility =
        "---\nmy_other_package: major\nmy_package: minor\n---\n\n### This is a summary\n";
    assert!(
        contents == first_possibility || contents == second_possibility,
        "Contents were not as expected: {}",
        contents
    );
}

#[test]
fn load_change() {
    let dir = tempdir().unwrap();
    let change_path = dir.path().join("a_change.md");
    std::fs::write(
        &change_path,
        "---\nmy_package: minor\n---\n\n### This is a summary\n",
    )
    .unwrap();

    let change = Change::from_file(&change_path).unwrap();

    assert_eq!(change.unique_id.to_string(), "a_change");
    assert_eq!(change.summary, "### This is a summary");
    assert_eq!(
        change.versioning,
        Versioning::from(("my_package", ChangeType::Minor))
    );
}
