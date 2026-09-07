# ambient-id

[![Crates.io Version](https://img.shields.io/crates/v/ambient-id)](https://crates.io/crates/ambient-id)

A library for accessing ambient OIDC credentials in a variety of environments.

This crate serves the same purpose as Python's [id] library.

## Supported environments

`ambient-id` currently supports ambient OIDC credential detection in the
following environments:

* GitHub Actions

  - GitHub Actions requires the `id-token: write` permission to be set
    at the job or workflow level. In general, users should set this at the
    job level to limit the scope of the permission.

    For additional information on OpenID Connect in GitHub Actions, see the
    [GitHub documentation].

* GitLab CI

  - On GitLab, this crate looks for an `<AUD>_ID_TOKEN` environment variable,
    where `<AUD>` is the audience string with non-alphanumeric characters
    replaced by underscores and converted to uppercase. For example, if the
    audience is `sigstore`, the crate will look for a `SIGSTORE_ID_TOKEN`
    environment variable.

    For additional information on OpenID Connect and `<AUD>_ID_TOKEN`
    environment variables, see the [GitLab documentation].

* Buildkite

  - On Buildkite, this crate invokes
    `buildkite-agent oidc request-token --audience <AUD>` to obtain the token.

    If you're using Buildkite's [Docker plugin], you'll need to
    propagate the environment and mount the Buildkite agent binary into
    the container for this to work correctly.

    Specifically, you'll need `propagate-environment: true` and
    `mount-buildkite-agent: true` set in your plugin configuration.

    For additional information on OpenID Connect in Buildkite, see the
    [Buildkite documentation].
  
* CircleCI

  - On CircleCI, this crate invokes
    `circleci run oidc get --root-issuer --claims '{"aud": <AUD>}'`
    to obtain the token.
  
    This crate only uses `--root-issuer`; per-organization issuers aren't
    supported. 

## Development

To run tests:

```sh
RUST_TEST_THREADS=1 cargo test
```

You **must** pass `RUST_TEST_THREADS=1` to ensure tests are run in a single
thread, as this crate's tests manipulate environment variables and are not
thread-safe.

## License

ambient-id is licensed under either of

* Apache License, Version 2.0, ([LICENSE-APACHE] or https://www.apache.org/licenses/LICENSE-2.0)
* MIT license ([LICENSE-MIT] or https://opensource.org/licenses/MIT)

at your option.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in ambient-id by you, as defined in the Apache-2.0
license, shall be dually licensed as above, without any additional terms or
conditions.

<div align="center">
  <a target="_blank" href="https://astral.sh" style="background:none">
    <img src="https://raw.githubusercontent.com/astral-sh/uv/main/assets/svg/Astral.svg" alt="Made by Astral">
  </a>
</div>

[id]: https://pypi.org/project/id/
[GitHub documentation]: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
[GitLab documentation]: https://docs.gitlab.com/ci/secrets/id_token_authentication/
[Docker plugin]: https://github.com/buildkite-plugins/docker-buildkite-plugin
[Buildkite documentation]: https://buildkite.com/docs/pipelines/security/oidc
[LICENSE-APACHE]: ./LICENSE-APACHE
[LICENSE-MIT]: ./LICENSE-MIT
