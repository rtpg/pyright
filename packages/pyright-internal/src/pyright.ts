/*
 * pyright.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Command-line entry point for pyright type checker.
 */

// Add the start timer at the very top of the file, before we import other modules.

/* eslint-disable */
import { timingStats } from './common/timing';
/* eslint-enable */

import chalk from 'chalk';
import commandLineArgs from 'command-line-args';
import { CommandLineOptions, OptionDefinition } from 'command-line-args';
import * as process from 'process';

import { AnalyzerService } from './analyzer/service';
import { CommandLineOptions as PyrightCommandLineOptions } from './common/commandLineOptions';
import { NullConsole } from './common/console';
import { Diagnostic, DiagnosticCategory } from './common/diagnostic';
import { FileDiagnostics } from './common/diagnosticSink';
import { combinePaths, normalizePath } from './common/pathUtils';
import { createFromRealFileSystem } from './common/fileSystem';
import { isEmptyRange, Range } from './common/textRange';

const toolName = 'pyright';

enum ExitStatus {
    NoErrors = 0,
    ErrorsReported = 1,
    FatalError = 2,
    ConfigFileParseError = 3,
}

interface PyrightJsonResults {
    version: string;
    time: string;
    diagnostics: PyrightJsonDiagnostic[];
    summary: PyrightJsonSummary;
}

interface PyrightJsonDiagnostic {
    file: string;
    severity: 'error' | 'warning' | 'information';
    message: string;
    range: Range;
}

interface PyrightJsonSummary {
    filesAnalyzed: number;
    errorCount: number;
    warningCount: number;
    informationCount: number;
    timeInSec: number;
}

interface DiagnosticResult {
    errorCount: number;
    warningCount: number;
    informationCount: number;
    diagnosticCount: number;
}

const cancellationNone = Object.freeze({
    isCancellationRequested: false,
    onCancellationRequested: function () {
        return {
            dispose() {
                /* empty */
            },
        };
    },
});

function processArgs() {
    const optionDefinitions: OptionDefinition[] = [
        { name: 'createstub', type: String },
        { name: 'dependencies', type: Boolean },
        { name: 'files', type: String, multiple: true, defaultOption: true },
        { name: 'help', alias: 'h', type: Boolean },
        { name: 'lib', type: Boolean },
        { name: 'outputjson', type: Boolean },
        { name: 'project', alias: 'p', type: String },
        { name: 'stats' },
        { name: 'typeshed-path', alias: 't', type: String },
        { name: 'venv-path', alias: 'v', type: String },
        { name: 'verbose', type: Boolean },
        { name: 'version', type: Boolean },
        { name: 'watch', alias: 'w', type: Boolean },
    ];

    let args: CommandLineOptions;

    try {
        args = commandLineArgs(optionDefinitions);
    } catch (err) {
        const argErr: { name: string; optionName: string } = err;
        if (argErr && argErr.optionName) {
            console.error(`Unexpected option ${argErr.optionName}.\n${toolName} --help for usage`);
            return;
        }

        console.error(`Unexpected error\n${toolName} --help for usage`);
        return;
    }

    if (args.help !== undefined) {
        printUsage();
        return;
    }

    if (args.version !== undefined) {
        printVersion();
        return;
    }

    if (args.outputjson) {
        const incompatibleArgs = ['watch', 'stats', 'verbose', 'createstub', 'dependencies'];
        for (const arg of incompatibleArgs) {
            if (args[arg] !== undefined) {
                console.error(`'outputjson' option cannot be used with '${arg}' option`);
                return;
            }
        }
    }

    const options = new PyrightCommandLineOptions(process.cwd(), false);

    // Assume any relative paths are relative to the working directory.
    if (args.files && Array.isArray(args.files)) {
        options.fileSpecs = args.files;
        options.fileSpecs = options.fileSpecs.map((f) => combinePaths(process.cwd(), f));
    } else {
        options.fileSpecs = [];
    }

    if (args.project) {
        options.configFilePath = combinePaths(process.cwd(), normalizePath(args.project));
    }

    if (args['venv-path']) {
        options.venvPath = combinePaths(process.cwd(), normalizePath(args['venv-path']));
    }

    if (args['typeshed-path']) {
        options.typeshedPath = combinePaths(process.cwd(), normalizePath(args['typeshed-path']));
    }

    if (args.createstub) {
        options.typeStubTargetImportName = args.createstub;
    }

    if (args.verbose) {
        options.verboseOutput = true;
    }
    if (args.lib) {
        options.useLibraryCodeForTypes = true;
    }
    options.checkOnlyOpenFiles = false;

    const output = args.outputjson ? new NullConsole() : undefined;
    const realFileSystem = createFromRealFileSystem(output);

    const watch = args.watch !== undefined;
    options.watchForSourceChanges = watch;

    const service = new AnalyzerService('<default>', realFileSystem, output);

    service.setCompletionCallback((results) => {
        if (results.fatalErrorOccurred) {
            process.exit(ExitStatus.FatalError);
        }

        if (results.configParseErrorOccurred) {
            process.exit(ExitStatus.ConfigFileParseError);
        }

        let errorCount = 0;
        if (results.diagnostics.length > 0 && !args.createstub) {
            if (args.outputjson) {
                const report = reportDiagnosticsAsJson(
                    results.diagnostics,
                    results.filesInProgram,
                    results.elapsedTime
                );
                errorCount += report.errorCount;
            } else {
                const report = reportDiagnosticsAsText(results.diagnostics);
                errorCount += report.errorCount;
            }
        }

        if (args.createstub && results.filesRequiringAnalysis === 0) {
            try {
                service.writeTypeStub(cancellationNone);
                service.dispose();
                console.log(`Type stub was created for '${args.createstub}'`);
            } catch (err) {
                let errMessage = '';
                if (err instanceof Error) {
                    errMessage = ': ' + err.message;
                }

                console.error(`Error occurred when creating type stub: ` + errMessage);
                process.exit(ExitStatus.FatalError);
            }
            process.exit(ExitStatus.NoErrors);
        }

        if (!args.outputjson) {
            if (!watch) {
                // Print the total time.
                timingStats.printSummary(console);
            }

            if (args.stats !== undefined) {
                // Print the stats details.
                service.printStats();
                timingStats.printDetails(console);
            }

            if (args.dependencies) {
                service.printDependencies(!!args.verbose);
            }
        }

        if (!watch) {
            process.exit(errorCount > 0 ? ExitStatus.ErrorsReported : ExitStatus.NoErrors);
        } else if (!args.outputjson) {
            console.log('Watching for file changes...');
        }
    });

    // This will trigger the analyzer.
    service.setOptions(options);

    // Sleep indefinitely.
    const brokenPromise = new Promise(() => {
        // Do nothing.
    });
    brokenPromise.then().catch();
}

function printUsage() {
    console.log(
        'Usage: ' +
            toolName +
            ' [options] files...\n' +
            '  Options:\n' +
            '  --createstub IMPORT              Create type stub file(s) for import\n' +
            '  --dependencies                   Emit import dependency information\n' +
            '  -h,--help                        Show this help message\n' +
            '  --lib                            Use library code to infer types when stubs are missing\n' +
            '  --outputjson                     Output results in JSON format\n' +
            '  -p,--project FILE OR DIRECTORY   Use the configuration file at this location\n' +
            '  --stats                          Print detailed performance stats\n' +
            '  -t,--typeshed-path DIRECTORY     Use typeshed type stubs at this location\n' +
            '  -v,--venv-path DIRECTORY         Directory that contains virtual environments\n' +
            '  --verbose                        Emit verbose diagnostics\n' +
            '  --version                        Print Pyright version\n' +
            '  -w,--watch                       Continue to run and watch for changes\n'
    );
}

function getVersionString() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const version = require('package.json').version;
    return version.toString();
}

function printVersion() {
    console.log(`${toolName} ${getVersionString()}`);
}

function reportDiagnosticsAsJson(
    fileDiagnostics: FileDiagnostics[],
    filesInProgram: number,
    timeInSec: number
): DiagnosticResult {
    const report: PyrightJsonResults = {
        version: getVersionString(),
        time: Date.now().toString(),
        diagnostics: [],
        summary: {
            filesAnalyzed: filesInProgram,
            errorCount: 0,
            warningCount: 0,
            informationCount: 0,
            timeInSec,
        },
    };

    let errorCount = 0;
    let warningCount = 0;
    let informationCount = 0;

    fileDiagnostics.forEach((fileDiag) => {
        fileDiag.diagnostics.forEach((diag) => {
            if (
                diag.category === DiagnosticCategory.Error ||
                diag.category === DiagnosticCategory.Warning ||
                diag.category === DiagnosticCategory.Information
            ) {
                report.diagnostics.push({
                    file: fileDiag.filePath,
                    severity:
                        diag.category === DiagnosticCategory.Error
                            ? 'error'
                            : DiagnosticCategory.Warning
                            ? 'warning'
                            : 'information',
                    message: diag.message,
                    range: diag.range,
                });

                if (diag.category === DiagnosticCategory.Error) {
                    errorCount++;
                } else if (diag.category === DiagnosticCategory.Warning) {
                    warningCount++;
                } else if (diag.category === DiagnosticCategory.Information) {
                    informationCount++;
                }
            }
        });
    });

    report.summary.errorCount = errorCount;
    report.summary.warningCount = warningCount;
    report.summary.informationCount = informationCount;

    console.log(JSON.stringify(report, undefined, 4));

    return {
        errorCount,
        warningCount,
        informationCount,
        diagnosticCount: errorCount + warningCount + informationCount,
    };
}

function reportDiagnosticsAsText(fileDiagnostics: FileDiagnostics[]): DiagnosticResult {
    let errorCount = 0;
    let warningCount = 0;
    let informationCount = 0;

    fileDiagnostics.forEach((fileDiagnostics) => {
        // Don't report unused code diagnostics.
        const fileErrorsAndWarnings = fileDiagnostics.diagnostics.filter(
            (diag) => diag.category !== DiagnosticCategory.UnusedCode
        );

        if (fileErrorsAndWarnings.length > 0) {
            console.log(`${fileDiagnostics.filePath}`);
            fileErrorsAndWarnings.forEach((diag) => {
                logDiagnosticToConsole(diag);

                if (diag.category === DiagnosticCategory.Error) {
                    errorCount++;
                } else if (diag.category === DiagnosticCategory.Warning) {
                    warningCount++;
                } else if (diag.category === DiagnosticCategory.Information) {
                    informationCount++;
                }
            });
        }
    });

    console.log(
        `${errorCount.toString()} ${errorCount === 1 ? 'error' : 'errors'}, ` +
            `${warningCount.toString()} ${warningCount === 1 ? 'warning' : 'warnings'}, ` +
            `${informationCount.toString()} ${informationCount === 1 ? 'info' : 'infos'} `
    );

    return {
        errorCount,
        warningCount,
        informationCount,
        diagnosticCount: errorCount + warningCount + informationCount,
    };
}

function logDiagnosticToConsole(diag: Diagnostic, prefix = '  ') {
    let message = prefix;
    if (diag.range && !isEmptyRange(diag.range)) {
        message +=
            chalk.yellow(`${diag.range.start.line + 1}`) +
            ':' +
            chalk.yellow(`${diag.range.start.character + 1}`) +
            ' - ';
    }

    const [firstLine, ...remainingLines] = diag.message.split('\n');

    message +=
        diag.category === DiagnosticCategory.Error
            ? chalk.red('error')
            : diag.category === DiagnosticCategory.Warning
            ? chalk.green('warning')
            : chalk.blue('info');
    message += `: ${firstLine}`;
    if (remainingLines.length > 0) {
        message += '\n' + prefix + remainingLines.join('\n' + prefix);
    }

    const rule = diag.getRule();
    if (rule) {
        message += chalk.gray(` (${rule})`);
    }

    console.log(message);
}

export function main() {
    processArgs();
}
