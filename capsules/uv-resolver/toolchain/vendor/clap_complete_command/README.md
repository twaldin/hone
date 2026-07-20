# clap-complete-command

[![crates.io](https://img.shields.io/crates/v/clap_complete_command)](https://crates.io/crates/clap_complete_command)

Reduces boilerplate for adding a shell completion command to Clap

## Compatible clap versions

| `clap` version | `clap_complete_command` version |
| -------------- | ------------------------------- |
| v3             | v0.1, v0.2, v0.3                |
| v4             | v0.4, v0.5, v0.6                |

## Examples

### Derive

```rust
use clap::{CommandFactory, Parser, Subcommand};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Generate shell completions
    Completions {
        /// The shell to generate the completions for
        #[arg(value_enum)]
        shell: clap_complete_command::Shell,
    },
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        // e.g. `$ cli completions bash`
        Commands::Completions { shell } => {
            shell.generate(&mut Cli::command(), &mut std::io::stdout());
        }
    }
}
```

### Builder

```rust
use clap::{Arg, Command};

fn build_cli() -> Command {
    Command::new(env!("CARGO_PKG_NAME"))
        .subcommand_required(true)
        .subcommand(
            Command::new("completions")
                .about("Generate shell completions")
                .arg(
                    Arg::new("shell")
                        .value_name("SHELL")
                        .help("The shell to generate the completions for")
                        .required(true)
                        .value_parser(
                            clap::builder::EnumValueParser::<clap_complete_command::Shell>::new(),
                        ),
                ),
        )
}

fn main() {
    let matches = build_cli().get_matches();

    match matches.subcommand() {
        Some(("completions", sub_matches)) => {
            // e.g. `$ cli completions bash`
            if let Some(shell) = sub_matches.get_one::<clap_complete_command::Shell>("shell") {
                let mut command = build_cli();
                shell.generate(&mut command, &mut std::io::stdout());
            }
        }
        _ => {
            unreachable!("Exhausted list of subcommands and `subcommand_required` prevents `None`")
        }
    }
}
```

## Supported shells

The supported shells can be seen in `clap_complete_command::Shell`.
