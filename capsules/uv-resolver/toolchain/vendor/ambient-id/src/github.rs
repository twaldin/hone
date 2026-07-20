//! GitHub Actions OIDC token detection.

use reqwest_middleware::ClientWithMiddleware;

use crate::{DetectionState, DetectionStrategy};

/// Possible errors during GitHub Actions OIDC token detection.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The GitHub Actions environment lacks necessary permissions.
    ///
    /// This is typically resolved by adding `id-token: write` to the
    /// job's `permissions` block.
    #[error("insufficient permissions: {0}")]
    InsufficientPermissions(&'static str),
    /// The HTTP request to fetch the ID token failed.
    #[error("HTTP request failed: {0}")]
    Request(#[from] reqwest_middleware::Error),
}

/// The JSON payload returned by GitHub's ID token endpoint.
#[derive(serde::Deserialize)]
struct TokenRequestResponse {
    value: String,
}

pub(crate) struct GitHubActions {
    client: ClientWithMiddleware,
}

impl DetectionStrategy for GitHubActions {
    type Error = Error;

    fn new(state: &DetectionState) -> Option<Self> {
        std::env::var("GITHUB_ACTIONS")
            .ok()
            // Per GitHub docs, this is exactly "true" when
            // running in GitHub Actions.
            .filter(|v| v == "true")
            .map(|_| GitHubActions {
                client: state.client.clone(),
            })
    }

    /// On GitHub Actions, the OIDC token URL is provided
    /// via the ACTIONS_ID_TOKEN_REQUEST_URL environment variable.
    /// We additionally need to fetch the ACTIONS_ID_TOKEN_REQUEST_TOKEN
    /// environment variable to authenticate the request.
    ///
    /// The absence of either variable indicates insufficient permissions.
    async fn detect(&self, audience: &str) -> Result<crate::IdToken, Self::Error> {
        let url = std::env::var("ACTIONS_ID_TOKEN_REQUEST_URL")
            .map_err(|_| Error::InsufficientPermissions("missing ACTIONS_ID_TOKEN_REQUEST_URL"))?;
        let token = std::env::var("ACTIONS_ID_TOKEN_REQUEST_TOKEN").map_err(|_| {
            Error::InsufficientPermissions("missing ACTIONS_ID_TOKEN_REQUEST_TOKEN")
        })?;

        let resp = self
            .client
            .get(&url)
            .bearer_auth(token)
            .query(&[("audience", audience)])
            .send()
            .await?
            .error_for_status()
            .map_err(reqwest_middleware::Error::Reqwest)?
            .json::<TokenRequestResponse>()
            .await
            .map_err(reqwest_middleware::Error::Reqwest)?;

        Ok(crate::IdToken(resp.value.into()))
    }
}

#[cfg(test)]
mod tests {
    use wiremock::{
        Mock, MockServer,
        matchers::{method, path},
    };

    use crate::{DetectionStrategy as _, tests::EnvScope};

    use super::GitHubActions;

    /// Happy path for GitHub Actions OIDC token detection.
    #[tokio::test]
    #[cfg_attr(not(feature = "test-github-1p"), ignore)]
    async fn test_1p_detection_ok() {
        let _ = EnvScope::new();
        let state = Default::default();
        let detector = GitHubActions::new(&state).expect("should detect GitHub Actions");
        let token = detector
            .detect("test_1p_detection_ok")
            .await
            .expect("should fetch token");

        assert!(token.reveal().starts_with("eyJ")); // JWTs start with "eyJ"
    }

    // Sad path: we're in GitHub Actions, but `ACTIONS_ID_TOKEN_REQUEST_URL`
    // is unset.
    #[tokio::test]
    #[cfg_attr(not(feature = "test-github-1p"), ignore)]
    async fn test_1p_detection_missing_url() {
        let mut scope = EnvScope::new();
        scope.unsetenv("ACTIONS_ID_TOKEN_REQUEST_URL");

        let state = Default::default();
        let detector = GitHubActions::new(&state).expect("should detect GitHub Actions");

        match detector.detect("test_1p_detection_missing_url").await {
            Err(super::Error::InsufficientPermissions(what)) => {
                assert_eq!(what, "missing ACTIONS_ID_TOKEN_REQUEST_URL")
            }
            _ => panic!("expected insufficient permissions error"),
        }
    }

    /// Sad path: we're in GitHub Actions, but `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
    /// is unset.
    #[tokio::test]
    #[cfg_attr(not(feature = "test-github-1p"), ignore)]
    async fn test_1p_detection_missing_token() {
        let mut scope = EnvScope::new();
        scope.unsetenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN");

        let state = Default::default();
        let detector = GitHubActions::new(&state).expect("should detect GitHub Actions");

        match detector.detect("test_1p_detection_missing_token").await {
            Err(super::Error::InsufficientPermissions(what)) => {
                assert_eq!(what, "missing ACTIONS_ID_TOKEN_REQUEST_TOKEN")
            }
            _ => panic!("expected insufficient permissions error"),
        }
    }

    #[tokio::test]
    async fn test_not_detected() {
        let mut scope = EnvScope::new();
        scope.unsetenv("GITHUB_ACTIONS");

        let state = Default::default();
        assert!(GitHubActions::new(&state).is_none());
    }

    #[tokio::test]
    async fn test_detected() {
        let mut scope = EnvScope::new();
        scope.setenv("GITHUB_ACTIONS", "true");

        let state = Default::default();
        assert!(GitHubActions::new(&state).is_some());
    }

    #[tokio::test]
    async fn test_not_detected_wrong_value() {
        for value in &["", "false", "TRUE", "1", "yes"] {
            let mut scope = EnvScope::new();
            scope.setenv("GITHUB_ACTIONS", value);

            let state = Default::default();
            assert!(GitHubActions::new(&state).is_none());
        }
    }

    #[tokio::test]
    async fn test_error_code() {
        let mut scope = EnvScope::new();
        let server = MockServer::start().await;

        scope.setenv("GITHUB_ACTIONS", "true");
        scope.setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "bogus");
        scope.setenv("ACTIONS_ID_TOKEN_REQUEST_URL", &server.uri());

        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(wiremock::ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let state = Default::default();
        let detector = GitHubActions::new(&state).expect("should detect GitHub Actions");
        assert!(matches!(
            detector.detect("test_error_code").await,
            Err(super::Error::Request(_))
        ));
    }

    #[tokio::test]
    async fn test_invalid_response() {
        let mut scope = EnvScope::new();
        let server = MockServer::start().await;

        scope.setenv("GITHUB_ACTIONS", "true");
        scope.setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "bogus");
        scope.setenv("ACTIONS_ID_TOKEN_REQUEST_URL", &server.uri());

        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "bogus": "response"
                })),
            )
            .mount(&server)
            .await;

        let state = Default::default();
        let detector = GitHubActions::new(&state).expect("should detect GitHub Actions");
        assert!(matches!(
            detector.detect("test_invalid_response").await,
            Err(super::Error::Request(_))
        ));
    }

    #[tokio::test]
    async fn test_ok() {
        let mut scope = EnvScope::new();
        let server = MockServer::start().await;

        scope.setenv("GITHUB_ACTIONS", "true");
        scope.setenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "bogus");
        scope.setenv("ACTIONS_ID_TOKEN_REQUEST_URL", &server.uri());

        Mock::given(method("GET"))
            .and(path("/"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "value": "test-ok-token"
                })),
            )
            .mount(&server)
            .await;

        let state = Default::default();
        let detector = GitHubActions::new(&state).expect("should detect GitHub Actions");
        let token = detector
            .detect("test_ok")
            .await
            .expect("should fetch token");

        assert_eq!(token.reveal(), "test-ok-token");
    }
}
