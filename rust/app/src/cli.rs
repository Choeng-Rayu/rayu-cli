use std::ffi::OsString;

use clap::{Arg, ArgAction, Command, value_parser};

/// The command `units::dispatch` gets when argv names no subcommand.
pub const ROOT: &str = "rayu";

fn rest() -> Arg {
    Arg::new("args")
        .num_args(0..)
        .trailing_var_arg(true)
        .allow_hyphen_values(true)
        .value_parser(value_parser!(OsString))
}

/// Routes argv to a command. Anything this parser rejects runs the original, so it never
/// has to match every way the original accepts its arguments.
pub fn command() -> Command {
    Command::new(ROOT)
        .disable_help_flag(true)
        .disable_version_flag(true)
        .disable_help_subcommand(true)
        .args_conflicts_with_subcommands(true)
        .arg(rest())
        .subcommand(
            Command::new("agents")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("doctor")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("install")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("mcp")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("plugin")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("plugins")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
        .subcommand(
            Command::new("uninstall")
                .disable_help_flag(true)
                .arg(Arg::new("help").long("help").action(ArgAction::Count))
                .arg(rest()),
        )
}
