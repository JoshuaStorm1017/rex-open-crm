import { formatGraphText } from './graph';
import { isScenarioName, runScenario, SCENARIO_NAMES } from './scenarios';

const [command = 'demo', ...args] = process.argv.slice(2);

if (command === 'graph') {
  process.stdout.write(`${formatGraphText()}\n`);
} else if (command === 'demo') {
  const scenario = readFlag(args, '--scenario') ?? 'happy';

  if (!isScenarioName(scenario)) {
    process.stderr.write(
      `Unknown scenario ${scenario}. Use one of: ${SCENARIO_NAMES.join(', ')}\n`,
    );
    process.exitCode = 1;
  } else {
    const report = await runScenario(scenario);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} else {
  process.stderr.write('Usage: tsx src/cli.ts demo --scenario happy | graph\n');
  process.exitCode = 1;
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
