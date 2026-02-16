import type { Command, Help } from 'commander';

function formatHelpCommandsFirst(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth || 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2;

  function formatItem(term: string, description?: string): string {
    if (description) {
      const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
      return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
    }
    return term;
  }

  function formatList(textArray: string[]): string {
    return textArray.join('\n').replace(/^/gm, ' '.repeat(itemIndentWidth));
  }

  let output = [`Usage: ${helper.commandUsage(cmd)}`, ''];

  const commandDescription = helper.commandDescription(cmd);
  if (commandDescription.length > 0) {
    output = output.concat([helper.wrap(commandDescription, helpWidth, 0), '']);
  }

  const argumentList = helper.visibleArguments(cmd).map((argument) => {
    return formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument));
  });
  if (argumentList.length > 0) {
    output = output.concat(['Arguments:', formatList(argumentList), '']);
  }

  const commandList = helper.visibleCommands(cmd).map((subcommand) => {
    return formatItem(helper.subcommandTerm(subcommand), helper.subcommandDescription(subcommand));
  });
  if (commandList.length > 0) {
    output = output.concat(['Commands:', formatList(commandList), '']);
  }

  const optionList = helper.visibleOptions(cmd).map((option) => {
    return formatItem(helper.optionTerm(option), helper.optionDescription(option));
  });
  if (optionList.length > 0) {
    output = output.concat(['Options:', formatList(optionList), '']);
  }

  if (helper.showGlobalOptions) {
    const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
      return formatItem(helper.optionTerm(option), helper.optionDescription(option));
    });
    if (globalOptionList.length > 0) {
      output = output.concat(['Global Options:', formatList(globalOptionList), '']);
    }
  }

  return output.join('\n');
}

function applyHelpConventionsRecursive(cmd: Command): void {
  cmd
    .helpOption('-h, --help', 'Show help')
    .addHelpCommand(false)
    .configureHelp({
      formatHelp: formatHelpCommandsFirst,
    });

  for (const subcommand of cmd.commands) {
    applyHelpConventionsRecursive(subcommand);
  }
}

export function applyGlobalHelpConventions(root: Command): void {
  applyHelpConventionsRecursive(root);
}
