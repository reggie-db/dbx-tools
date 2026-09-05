mod bindings;
mod client;
mod error;
mod oauth;
mod oauth_template;
mod provider;
mod storage;
pub mod token;

pub use bindings::*;
pub use client::{AuthClient, AuthOptions, TokenProvider};
pub use error::{Error, Result};
pub use oauth::{OAuthConfig, OAuthFlow};
pub use oauth_template::{default_callback_image_src, OAuthTemplate, OAuthTemplateContext};
pub use provider::*;
pub use storage::*;
pub use token::Token;

uniffi::setup_scaffolding!();
