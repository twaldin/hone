# Release Steps

1. Update the version number in `Cargo.toml`, the Cargo dependency example in
   `src/lib.rs` and the documentation in `src/manifest/mod.rs`.
2. Finish the changelog for the version in `CHANGELOG.md`.
3. Commit all the changes.
4. Check the release contents with `cargo package --list`, and check that the
   release will work with `cargo publish --dry-run`.
5. Tag the version with a message to make it an annotated tag:
   `git tag -m 'Version 1.m.n.'`. (Review these with `git tag -n`.)
6. Push the code and tags to Codeberg, and wait for the tests to finish
   successfully: `git push --all`.
7. Create a new release from the tag at <https://codeberg.org/carey/embed-manifest/tags>.
8. Upload the new version to [crates.io](https://crates.io/crates/embed-manifest)
   with `cargo publish`.

After the release, create an “unreleased” entry in the changelog:

    ## [Unreleased]
    [Unreleased]: https://codeberg.org/carey/embed-manifest/-/compare/v1.m.n...main
