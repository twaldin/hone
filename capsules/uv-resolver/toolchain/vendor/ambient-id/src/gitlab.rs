//! GitLab CI OIDC token detection.

use crate::{DetectionState, DetectionStrategy};

/// Possible errors during GitLab CI OIDC token detection.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The expected environment variable for the ID token was not found.
    #[error("ID token variable not found: {0}")]
    Missing(String),
}

pub(crate) struct GitLabCI;

impl GitLabCI {
    /// Normalizes an audience string into the format required
    /// for GitLab CI ID token environment variables.
    ///
    /// Specifically, this uppercases all alphanumeric characters
    /// and replaces all non-alphanumeric characters with underscores.
    ///
    /// For example, "sigstore" becomes "SIGSTORE",
    /// and "http://test.audience" becomes "HTTP___TEST_AUDIENCE".
    fn normalized_audience(audience: &str) -> String {
        audience
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect()
    }
}

impl DetectionStrategy for GitLabCI {
    type Error = Error;

    fn new(_state: &DetectionState) -> Option<Self> {
        std::env::var("GITLAB_CI")
            .ok()
            // Per GitLab docs, this is exactly "true" when
            // running in GitLab CI.
            .filter(|v| v == "true")
            .map(|_| GitLabCI)
    }

    /// On GitLab CI, the OIDC token URL is provided via an environment variable.
    /// Specifically, we look for `<AUD>_ID_TOKEN` where `<AUD>` is the
    /// audience, uppercased and with non-ASCII-alphanumeric characters replaced by `_`.
    ///
    /// As an example, audience "sigstore" would require variable SIGSTORE_ID_TOKEN,
    /// and audience "http://test.audience" would require variable
    /// HTTP___TEST_AUDIENCE_ID_TOKEN.
    async fn detect(&self, audience: &str) -> Result<crate::IdToken, Self::Error> {
        let normalized_audience = Self::normalized_audience(audience);

        let var_name = format!("{normalized_audience}_ID_TOKEN");
        let token = std::env::var(&var_name).map_err(|_| Error::Missing(var_name))?;

        Ok(crate::IdToken(token.into()))
    }
}

#[cfg(test)]
mod tests {
    use crate::{DetectionStrategy as _, gitlab::Error, tests::EnvScope};

    use super::GitLabCI;

    #[test]
    fn test_normalized_audience() {
        let cases = [
            ("sigstore", "SIGSTORE"),
            ("http://test.audience", "HTTP___TEST_AUDIENCE"),
            ("my-audience_123", "MY_AUDIENCE_123"),
            ("Audience With Spaces!", "AUDIENCE_WITH_SPACES_"),
            // TODO(ww): This mirrors what `id` does, but maybe we should
            // reject audiences with non-ASCII characters? Or reject those
            // that normalize to only underscores?
            ("😭", "_"),
            ("😭😭😭", "___"),
        ];

        for (input, expected) in cases {
            assert_eq!(GitLabCI::normalized_audience(input), expected);
        }
    }

    #[tokio::test]
    async fn test_detected() {
        let mut scope = EnvScope::new();
        scope.setenv("GITLAB_CI", "true");

        assert!(GitLabCI::new(&Default::default()).is_some())
    }

    #[tokio::test]
    async fn test_not_detected() {
        let mut scope = EnvScope::new();
        scope.unsetenv("GITLAB_CI");

        assert!(GitLabCI::new(&Default::default()).is_none());
    }

    #[tokio::test]
    async fn test_not_detected_wrong_value() {
        for value in &["", "false", "TRUE", "1", "yes"] {
            let mut scope = EnvScope::new();
            scope.setenv("GITLAB_CI", value);

            assert!(GitLabCI::new(&Default::default()).is_none());
        }
    }

    #[tokio::test]
    async fn test_invalid_missing() {
        let mut scope = EnvScope::new();
        scope.setenv("GITLAB_CI", "true");
        scope.setenv("WRONG_ID_TOKEN", "sometoken");

        let detector = GitLabCI::new(&Default::default()).expect("should detect GitLab CI");
        assert!(matches!(
            detector.detect("bupkis").await,
            Err(Error::Missing(_))
        ));
    }

    #[tokio::test]
    async fn test_ok() {
        let mut scope = EnvScope::new();
        scope.setenv("GITLAB_CI", "true");
        scope.setenv("BUPKIS_ID_TOKEN", "sometoken");

        let detector = GitLabCI::new(&Default::default()).expect("should detect GitLab CI");
        let token = detector.detect("bupkis").await.expect("should fetch token");
        assert_eq!(token.reveal(), "sometoken");
    }
}
