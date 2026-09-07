//! CircleCI OIDC token detection.

use serde_json::json;

use crate::DetectionStrategy;

/// Possible errors during BuildKite OIDC token detection.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An error occurred while executing the `circleci` command.
    #[error("failed to obtain OIDC token from `circleci` CLI")]
    Execution(#[from] std::io::Error),
}

pub(crate) struct CircleCI;

impl DetectionStrategy for CircleCI {
    type Error = Error;

    fn new(_state: &crate::DetectionState) -> Option<Self>
    where
        Self: Sized,
    {
        // https://circleci.com/docs/reference/variables/#built-in-environment-variables
        std::env::var("CIRCLECI")
            .ok()
            .filter(|v| v == "true")
            .map(|_| CircleCI)
    }

    /// On CircleCI, the OIDC token is provided by the `circleci` tool.
    /// Specifically, we need to invoke:
    ///
    /// ```sh
    /// circleci run oidc get --root-issuer --claims '{"aud": <audience>}'
    /// ```
    ///
    /// The standard output of this command is the ID token on success.
    async fn detect(&self, audience: &str) -> Result<crate::IdToken, Self::Error> {
        let output = std::process::Command::new("circleci")
            .args(&[
                "run",
                "oidc",
                "get",
                "--root-issuer",
                "--claims",
                &json!({
                    "aud": audience
                })
                .to_string(),
            ])
            .output()?;

        if !output.status.success() {
            return Err(Error::Execution(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!(
                    "`circleci` exited with code {status}: '{stderr}'",
                    status = output.status,
                    stderr = String::from_utf8_lossy(&output.stderr),
                ),
            )));
        }

        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(crate::IdToken(token.into()))
    }
}

#[cfg(test)]
mod tests {
    use crate::{DetectionStrategy as _, circleci::CircleCI, tests::EnvScope};

    #[tokio::test]
    async fn test_not_detected() {
        let mut scope = EnvScope::new();
        scope.unsetenv("CIRCLECI");

        let state = Default::default();
        assert!(CircleCI::new(&state).is_none());
    }

    #[tokio::test]
    async fn test_detected() {
        let mut scope = EnvScope::new();
        scope.setenv("CIRCLECI", "true");

        let state = Default::default();
        assert!(CircleCI::new(&state).is_some());
    }

    /// Happy path for CircleCI OIDC token detection.
    #[tokio::test]
    #[cfg_attr(not(feature = "test-circleci-1p"), ignore)]
    async fn test_1p_detection_ok() {
        let _ = EnvScope::new();
        let state = Default::default();
        let detector = CircleCI::new(&state).expect("should detect CircleCI");
        let token = detector
            .detect("test_1p_detection_ok")
            .await
            .expect("should fetch token");

        assert!(token.reveal().starts_with("eyJ"));
    }
}
