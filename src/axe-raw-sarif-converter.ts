// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { isEmpty } from './array-utils';
import {
    AxeRawCheckResult,
    AxeRawNodeResult,
    AxeRawResult,
    ResultValue,
} from './axe-raw-result';
import { ConverterOptions } from './converter-options';
import { DictionaryStringTo } from './dictionary-types';
import { EnvironmentData } from './environment-data';
import * as CustomSarif from './sarif/custom-sarif-types';
import * as Sarif from './sarif/sarif-2.0.0';
import { SarifLog } from './sarif/sarif-log';
import { escapeForMarkdown, isNotEmpty } from './string-utils';

export class AxeRawSarifConverter {
    public convert(
        results: AxeRawResult[],
        options: ConverterOptions,
        environmentData: EnvironmentData,
    ): SarifLog {
        return {
            version: CustomSarif.SarifLogVersion.v2,
            runs: [this.convertRun(results, options, environmentData)],
        };
    }

    private convertRun(
        results: AxeRawResult[],
        options: ConverterOptions,
        environmentData: EnvironmentData,
    ): Sarif.Run {
        const files: DictionaryStringTo<Sarif.File> = {};
        files[environmentData.targetPageUrl] = {
            mimeType: 'text/html',
            properties: {
                tags: ['target'],
                title: environmentData.targetPageTitle,
            },
        };

        let extraSarifResultProperties: DictionaryStringTo<string> = {};

        if (options && options.scanName !== undefined) {
            extraSarifResultProperties = {
                scanName: options.scanName,
            };
        }

        const run: Sarif.Run = {
            tool: {
                name: 'axe',
                fullName: 'axe-core',
                semanticVersion: '3.2.2',
                version: '3.2.2',
                properties: {
                    downloadUri: 'https://www.deque.com/axe/',
                },
            },
            invocations: [
                {
                    startTime: environmentData.timestamp,
                    endTime: environmentData.timestamp,
                },
            ],
            files: files,
            results: this.convertRawResults(
                results,
                extraSarifResultProperties,
                environmentData,
            ),
            resources: {
                rules: this.convertResultsToRules(results),
            },
            properties: {},
        };

        if (options && options.testCaseId !== undefined) {
            run.properties!.testCaseId = options.testCaseId;
        }

        if (options && options.scanId !== undefined) {
            run.logicalId = options.scanId;
        }

        return run;
    }

    private convertRawResults(
        results: AxeRawResult[],
        extraSarifResultProperties: DictionaryStringTo<string>,
        environmentData: EnvironmentData,
    ): Sarif.Result[] {
        const resultArray: Sarif.Result[] = [];

        for (const result of results) {
            const axeRawNodeResultArrays = [
                result.violations,
                result.passes,
                result.incomplete,
                result.inapplicable,
            ];

            for (const axeRawNodeResultArray of axeRawNodeResultArrays) {
                if (!axeRawNodeResultArray) {
                    continue;
                }
                resultArray.push(
                    ...this.convertRawNodeResults(
                        axeRawNodeResultArray,
                        extraSarifResultProperties,
                        environmentData.targetPageUrl,
                        result.id,
                    ),
                );
            }
            if (axeRawNodeResultArrays.every(isEmpty)) {
                resultArray.push(
                    this.generateResultForInapplicableRule(
                        extraSarifResultProperties,
                        result.id,
                    ),
                );
            }
        }

        return resultArray;
    }

    private generateResultForInapplicableRule(
        extraSarifResultProperties: DictionaryStringTo<string>,
        ruleId: string,
    ): Sarif.Result {
        return {
            ruleId: ruleId,
            level: CustomSarif.Result.level.notApplicable,
            properties: {
                ...extraSarifResultProperties,
                tags: ['Accessibility'],
            },
            partialFingerprints: {
                ruleId: ruleId,
            },
        };
    }

    private getSarifResultLevel(
        resultValue?: ResultValue,
    ): CustomSarif.Result.level {
        const resultToLevelMapping: {
            [K in ResultValue]: CustomSarif.Result.level
        } = {
            passed: CustomSarif.Result.level.pass,
            failed: CustomSarif.Result.level.error,
            inapplicable: CustomSarif.Result.level.notApplicable,
            cantTell: CustomSarif.Result.level.open,
        };

        if (!resultValue) {
            throw new Error(
                'getSarifResultLevel(resultValue): resultValue is undefined',
            );
        }

        return resultToLevelMapping[resultValue];
    }

    private convertRawNodeResults(
        rawNodeResults: AxeRawNodeResult[],
        extraSarifResultProperties: DictionaryStringTo<string>,
        targetPageUrl: string,
        ruleId: string,
    ): Sarif.Result[] {
        if (rawNodeResults) {
            return rawNodeResults.map(rawNodeResult =>
                this.convertRawNodeResult(
                    rawNodeResult,
                    extraSarifResultProperties,
                    targetPageUrl,
                    ruleId,
                ),
            );
        }
        return [];
    }

    private convertRawNodeResult(
        axeRawNodeResult: AxeRawNodeResult,
        extraSarifResultProperties: DictionaryStringTo<string>,
        targetPageUrl: string,
        ruleId: string,
    ): Sarif.Result {
        const level = this.getSarifResultLevel(axeRawNodeResult.result);
        const selector = this.getLogicalNameFromRawNode(axeRawNodeResult);
        return {
            ruleId: ruleId,
            level: level,
            message: this.convertMessage(axeRawNodeResult, level),
            locations: [
                {
                    physicalLocation: {
                        fileLocation: {
                            uri: targetPageUrl,
                        },
                    },
                    fullyQualifiedLogicalName: selector,
                    annotations: [
                        {
                            snippet: {
                                text: axeRawNodeResult.node.source,
                            },
                        },
                    ],
                },
            ],
            properties: {
                ...extraSarifResultProperties,
                tags: ['Accessibility'],
            },
            partialFingerprints: {
                fullyQualifiedLogicalName: selector,
                ruleId: ruleId,
            },
        };
    }

    private getLogicalNameFromRawNode(axeRawNodeResult: AxeRawNodeResult) {
        if (!axeRawNodeResult.node.selector) {
            throw new Error(
                'getLogicalNameFromRawNode: axe result contained a node with no selector',
            );
        }
        return axeRawNodeResult.node.selector.join(';');
    }

    private convertMessage(
        node: AxeRawNodeResult,
        level: CustomSarif.Result.level,
    ): CustomSarif.Message {
        const textArray: string[] = [];
        const richTextArray: string[] = [];

        if (level === CustomSarif.Result.level.error) {
            const allAndNone = node.all.concat(node.none);
            this.convertMessageChecks(
                'Fix all of the following:',
                allAndNone,
                textArray,
                richTextArray,
            );
            this.convertMessageChecks(
                'Fix any of the following:',
                node.any,
                textArray,
                richTextArray,
            );
        } else {
            const allNodes = node.all.concat(node.none).concat(node.any);
            this.convertMessageChecks(
                'The following tests passed:',
                allNodes,
                textArray,
                richTextArray,
            );
        }

        return {
            text: textArray.join(' '),
            richText: richTextArray.join('\n\n'),
        };
    }

    private convertMessageChecks(
        heading: string,
        checkResults: AxeRawCheckResult[],
        textArray: string[],
        richTextArray: string[],
    ): void {
        if (checkResults.length > 0) {
            const textLines: string[] = [];
            const richTextLines: string[] = [];

            textLines.push(heading);
            richTextLines.push(escapeForMarkdown(heading));

            for (const checkResult of checkResults) {
                const message = isNotEmpty(checkResult.message)
                    ? checkResult.message
                    : checkResult.id;

                textLines.push(message + '.');
                richTextLines.push('- ' + escapeForMarkdown(message));
            }

            textArray.push(textLines.join(' '));
            richTextArray.push(richTextLines.join('\n'));
        }
    }

    private convertResultsToRules(
        results: AxeRawResult[],
    ): DictionaryStringTo<Sarif.Rule> {
        const rulesDictionary: DictionaryStringTo<Sarif.Rule> = {};

        for (const result of results) {
            rulesDictionary[result.id] = this.axeRawResultToSarifRule(result);
        }

        return rulesDictionary;
    }

    private axeRawResultToSarifRule(axeRawResult: AxeRawResult): Sarif.Rule {
        return {
            id: axeRawResult.id,
            name: {
                text: axeRawResult.help,
            },
            fullDescription: {
                text: axeRawResult.description,
            },
            helpUri: axeRawResult.helpUrl,
            properties: {},
        };
    }
}
