//! # Examples
//!
//! ## Derive
//!
//! ```no_run
//! use clap::{CommandFactory, Parser, Subcommand};
//!
//! #[derive(Parser)]
//! struct Cli {
//!     #[command(subcommand)]
//!     command: Commands,
//! }
//!
//! #[derive(Subcommand)]
//! enum Commands {
//!     /// Generate shell completions
//!     Completions {
//!         /// The shell to generate the completions for
//!         #[arg(value_enum)]
//!         shell: clap_complete_command::Shell,
//!     },
//! }
//!
//! let cli = Cli::parse();
//!
//! match cli.command {
//!     // e.g. `$ cli completions bash`
//!     Commands::Completions { shell } => {
//!         shell.generate(&mut Cli::command(), &mut std::io::stdout());
//!     }
//! }
//! ```
//!
//! ## Builder
//!
//! ```no_run
//! use clap::{Arg, Command};
//!
//! fn build_cli() -> Command {
//!     Command::new(env!("CARGO_PKG_NAME"))
//!         .subcommand_required(true)
//!         .subcommand(
//!             Command::new("completions")
//!                 .about("Generate shell completions")
//!                 .arg(
//!                     Arg::new("shell")
//!                         .value_name("SHELL")
//!                         .help("The shell to generate the completions for")
//!                         .required(true)
//!                         .value_parser(
//!                             clap::builder::EnumValueParser::<clap_complete_command::Shell>::new(),
//!                         ),
//!                 ),
//!         )
//! }
//!
//! let matches = build_cli().get_matches();
//!
//! match matches.subcommand() {
//!     Some(("completions", sub_matches)) => {
//!         // e.g. `$ cli completions bash`
//!         if let Some(shell) = sub_matches.get_one::<clap_complete_command::Shell>("shell") {
//!             let mut command = build_cli();
//!             shell.generate(&mut command, &mut std::io::stdout());
//!         }
//!     }
//!     _ => {
//!         unreachable!("Exhausted list of subcommands and `subcommand_required` prevents `None`")
//!     }
//! }
//! ```

#![cfg_attr(docsrs, feature(doc_auto_cfg))]

#![warn(clippy::cast_lossless)]
#![warn(clippy::cast_possible_wrap)]
#![warn(clippy::default_trait_access)]
#![warn(clippy::else_if_without_else)]
#![warn(clippy::empty_enum)]
#![warn(clippy::empty_line_after_outer_attr)]
#![warn(clippy::enum_glob_use)]
#![warn(clippy::equatable_if_let)]
#![warn(clippy::float_cmp)]
#![warn(clippy::fn_params_excessive_bools)]
#![warn(clippy::get_unwrap)]
#![warn(clippy::inefficient_to_string)]
#![warn(clippy::integer_division)]
#![warn(clippy::let_unit_value)]
#![warn(clippy::linkedlist)]
#![warn(clippy::lossy_float_literal)]
#![warn(clippy::macro_use_imports)]
#![warn(clippy::manual_assert)]
#![warn(clippy::manual_ok_or)]
#![warn(clippy::many_single_char_names)]
#![warn(clippy::map_unwrap_or)]
#![warn(clippy::match_bool)]
#![warn(clippy::match_on_vec_items)]
#![warn(clippy::match_same_arms)]
#![warn(clippy::match_wild_err_arm)]
#![warn(clippy::match_wildcard_for_single_variants)]
#![warn(clippy::mem_forget)]
#![warn(clippy::missing_const_for_fn)]
#![warn(clippy::must_use_candidate)]
#![warn(clippy::mut_mut)]
#![warn(clippy::negative_feature_names)]
#![warn(non_ascii_idents)]
#![warn(clippy::option_option)]
#![warn(clippy::redundant_feature_names)]
#![warn(clippy::redundant_pub_crate)]
#![warn(clippy::single_match_else)]
#![warn(clippy::str_to_string)]
#![warn(clippy::string_to_string)]
#![warn(clippy::trait_duplication_in_bounds)]
#![warn(clippy::unused_async)]
#![warn(clippy::unused_self)]
#![warn(clippy::use_self)]
#![warn(clippy::wildcard_dependencies)]
#![warn(clippy::wildcard_imports)]
#![warn(clippy::zero_sized_map_values)]

use std::{ffi::OsString, path::PathBuf};

use clap::ValueEnum;

/// A [`clap::ValueEnum`] for available shell completions.
///
/// # Examples
///
/// ## Derive
///
/// ```no_run
/// use clap::{Parser, Subcommand};
///
/// #[derive(Parser)]
/// struct Cli {
///     #[command(subcommand)]
///     command: Commands,
/// }
///
/// #[derive(Subcommand)]
/// enum Commands {
///     Completions {
///         #[arg(value_enum)]
///         shell: clap_complete_command::Shell,
///     },
/// }
/// ```
///
/// ## Builder
///
/// ```no_run
/// use clap::{Arg, Command};
///
/// fn build_cli() -> Command {
///     Command::new(env!("CARGO_PKG_NAME"))
///         .subcommand_required(true)
///         .subcommand(
///             Command::new("completions")
///                 .about("Generate shell completions")
///                 .arg(
///                     Arg::new("shell")
///                         .value_name("SHELL")
///                         .help("The shell to generate the completions for")
///                         .required(true)
///                         .value_parser(
///                             clap::builder::EnumValueParser::<clap_complete_command::Shell>::new(),
///                         ),
///                 ),
///         )
/// }
///
/// let matches = build_cli().get_matches();
///
/// match matches.subcommand() {
///     Some(("completions", sub_matches)) => {
///         if let Some(shell) = sub_matches.get_one::<clap_complete_command::Shell>("shell") {
///             // ...
///         }
///     }
///     _ => {
///         unreachable!("Exhausted list of subcommands and `subcommand_required` prevents `None`")
///     }
/// }
/// ```
#[derive(Clone, Copy, Debug)]
#[non_exhaustive]
pub enum Shell {
    /// Bourne Again SHell (bash)
    Bash,
    /// Carapace spec
    #[cfg(feature = "carapace")]
    Carapace,
    /// Elvish shell
    Elvish,
    /// Fig
    #[cfg(feature = "fig")]
    Fig,
    /// Friendly Interactive SHell (fish)
    Fish,
    /// NUshell (nu)
    #[cfg(feature = "nushell")]
    Nu,
    /// PowerShell
    PowerShell,
    /// Z SHell (zsh)
    Zsh,
}

impl clap_complete::Generator for Shell {
    fn file_name(&self, name: &str) -> String {
        match self {
            Self::Bash => clap_complete::Shell::Bash.file_name(name),
            Self::Elvish => clap_complete::Shell::Elvish.file_name(name),
            Self::Fish => clap_complete::Shell::Fish.file_name(name),
            Self::PowerShell => clap_complete::Shell::PowerShell.file_name(name),
            Self::Zsh => clap_complete::Shell::Zsh.file_name(name),

            #[cfg(feature = "carapace")]
            Self::Carapace => carapace_spec_clap::Spec.file_name(name),
            #[cfg(feature = "fig")]
            Self::Fig => clap_complete_fig::Fig.file_name(name),
            #[cfg(feature = "nushell")]
            Self::Nu => clap_complete_nushell::Nushell.file_name(name),
        }
    }

    fn generate(&self, cmd: &clap::Command, buf: &mut dyn std::io::Write) {
        match self {
            Self::Bash => clap_complete::Shell::Bash.generate(cmd, buf),
            Self::Elvish => clap_complete::Shell::Elvish.generate(cmd, buf),
            Self::Fish => clap_complete::Shell::Fish.generate(cmd, buf),
            Self::PowerShell => clap_complete::Shell::PowerShell.generate(cmd, buf),
            Self::Zsh => clap_complete::Shell::Zsh.generate(cmd, buf),

            #[cfg(feature = "carapace")]
            Self::Carapace => carapace_spec_clap::Spec.generate(cmd, buf),
            #[cfg(feature = "fig")]
            Self::Fig => clap_complete_fig::Fig.generate(cmd, buf),
            #[cfg(feature = "nushell")]
            Self::Nu => clap_complete_nushell::Nushell.generate(cmd, buf),
        }
    }
}

impl Shell {
    /// See [`clap_complete::generate()`].
    ///
    /// The `command`'s bin name is used as the completion's bin name.
    /// If the `command`'s bin name is not set, it will be set to the `command`'s name.
    pub fn generate(self, command: &mut clap::Command, buffer: &mut dyn std::io::Write) {
        let bin_name = command
            .get_bin_name()
            .unwrap_or_else(|| command.get_name())
            .to_owned();
        clap_complete::generate(self, command, bin_name, buffer)
    }

    /// See [`clap_complete::generate_to()`].
    ///
    /// The `command`'s bin name is used as the completion's bin name.
    /// If the `command`'s bin name is not set, it will be set to the `command`'s name.
    pub fn generate_to<S>(
        self,
        command: &mut clap::Command,
        out_dir: S,
    ) -> Result<PathBuf, std::io::Error>
    where
        S: Into<OsString>,
    {
        let bin_name = command
            .get_bin_name()
            .unwrap_or_else(|| command.get_name())
            .to_owned();
        clap_complete::generate_to(self, command, bin_name, out_dir)
    }
}

// Hand-rolled to avoid depending on Clap's `derive` feature
impl ValueEnum for Shell {
    fn value_variants<'a>() -> &'a [Self] {
        &[
            Self::Bash,
            #[cfg(feature = "carapace")]
            Self::Carapace,
            Self::Elvish,
            #[cfg(feature = "fig")]
            Self::Fig,
            Self::Fish,
            #[cfg(feature = "nushell")]
            Self::Nu,
            Self::PowerShell,
            Self::Zsh,
        ]
    }

    fn to_possible_value(&self) -> Option<clap::builder::PossibleValue> {
        Some(match self {
            Self::Bash => clap::builder::PossibleValue::new("bash"),
            #[cfg(feature = "carapace")]
            Self::Carapace => clap::builder::PossibleValue::new("carapace"),
            Self::Elvish => clap::builder::PossibleValue::new("elvish"),
            #[cfg(feature = "fig")]
            Self::Fig => clap::builder::PossibleValue::new("fig"),
            Self::Fish => clap::builder::PossibleValue::new("fish"),
            #[cfg(feature = "nushell")]
            Self::Nu => clap::builder::PossibleValue::new("nushell"),
            Self::PowerShell => clap::builder::PossibleValue::new("powershell"),
            Self::Zsh => clap::builder::PossibleValue::new("zsh"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::ValueEnum;

    macro_rules! check_shell_value_test {
        ($test_name:ident, $shell:expr, $value:expr) => {
            #[test]
            fn $test_name() {
                assert_eq!($shell.to_possible_value().unwrap().get_name(), $value);
            }
        };
    }

    check_shell_value_test!(test_shell_value_bash, Shell::Bash, "bash");
    #[cfg(feature = "carapace")]
    check_shell_value_test!(test_shell_value_carapace, Shell::Carapace, "carapace");
    check_shell_value_test!(test_shell_value_elvish, Shell::Elvish, "elvish");
    #[cfg(feature = "fig")]
    check_shell_value_test!(test_shell_value_fig, Shell::Fig, "fig");
    check_shell_value_test!(test_shell_value_fish, Shell::Fish, "fish");
    #[cfg(feature = "nushell")]
    check_shell_value_test!(test_shell_value_nushell, Shell::Nu, "nushell");
    check_shell_value_test!(test_shell_value_powershell, Shell::PowerShell, "powershell");
    check_shell_value_test!(test_shell_value_zsh, Shell::Zsh, "zsh");

    #[test]
    fn check_order() {
        let names = Shell::value_variants()
            .iter()
            .map(|shell| shell.to_possible_value().unwrap().get_name().to_owned())
            .collect::<Vec<_>>();

        let mut sorted = names.clone();
        sorted.sort_unstable();

        assert_eq!(names, sorted);

        let correct_order = [
            ("bash", true),
            ("carapace", cfg!(feature = "carapace")),
            ("elvish", true),
            ("fig", cfg!(feature = "fig")),
            ("fish", true),
            ("nushell", cfg!(feature = "nushell")),
            ("powershell", true),
            ("zsh", true),
        ]
        .iter()
        .filter(|(_, enabled)| *enabled)
        .map(|(shell, _)| *shell)
        .collect::<Vec<_>>();

        assert_eq!(names, correct_order);
    }
}
