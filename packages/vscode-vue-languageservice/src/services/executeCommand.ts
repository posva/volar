import {
	Range,
	TextEdit,
	Connection,
} from 'vscode-languageserver';
import { SourceFile } from '../sourceFiles';
import { Commands } from '../commands';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { pugToHtml, htmlToPug } from '@volar/pug';
import { ShowReferencesNotification } from '@volar/shared';
import type * as ts2 from '@volar/vscode-typescript-languageservice';
import { SearchTexts } from '../virtuals/common';
import * as findReferences from './references';

export function register(sourceFiles: Map<string, SourceFile>, tsLanguageService: ts2.LanguageService) {
	const _findReferences = findReferences.register(sourceFiles, tsLanguageService);
	return async (document: TextDocument, command: string, args: any[] | undefined, connection: Connection) => {
		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return;

		if (command === Commands.SHOW_REFERENCES && args) {
			const uri = args[0];
			const pos = args[1];
			const locs = args[2];
			connection.sendNotification(ShowReferencesNotification.type, { uri, position: pos, references: locs });
		}
		if (command === Commands.SWITCH_REF_SUGAR) {
			const desc = sourceFile.getDescriptor();
			if (!desc.scriptSetup) return;
			const genData = sourceFile.getScriptSetupData();
			if (!genData) return;
			let edits: TextEdit[] = [];
			if (genData.data.labels.length) {
				// unuse ref sugar
				for (const label of genData.data.labels) {
					edits.push(TextEdit.replace({
						start: document.positionAt(desc.scriptSetup.loc.start + label.label.start),
						end: document.positionAt(desc.scriptSetup.loc.start + label.label.end + 1),
					}, 'const'));
					if (!label.right.isComputedCall) {
						edits.push(TextEdit.replace({
							start: document.positionAt(desc.scriptSetup.loc.start + label.right.start),
							end: document.positionAt(desc.scriptSetup.loc.start + label.right.start),
						}, 'ref('));
						edits.push(TextEdit.replace({
							start: document.positionAt(desc.scriptSetup.loc.start + label.right.end),
							end: document.positionAt(desc.scriptSetup.loc.start + label.right.end),
						}, ')'));
					}
					for (const _var of label.vars) {
						const varRange = {
							start: document.positionAt(desc.scriptSetup.loc.start + _var.start),
							end: document.positionAt(desc.scriptSetup.loc.start + _var.end),
						};
						const varText = document.getText(varRange);
						const references = _findReferences(document, varRange.start) ?? [];
						for (const reference of references) {
							if (reference.uri !== document.uri)
								continue;
							const refernceRange = {
								start: document.offsetAt(reference.range.start),
								end: document.offsetAt(reference.range.end),
							};
							if (refernceRange.start === desc.scriptSetup.loc.start + _var.start && refernceRange.end === desc.scriptSetup.loc.start + _var.end)
								continue;
							if (refernceRange.start >= desc.scriptSetup.loc.start && refernceRange.end <= desc.scriptSetup.loc.end) {
								const referenceText = document.getText().substring(refernceRange.start, refernceRange.end);
								const isRaw = `$${varText}` === referenceText;
								if (isRaw) {
									edits.push(TextEdit.replace(reference.range, varText));
								}
								else {
									edits.push(TextEdit.replace(reference.range, varText + '.value'));
								}
							}
						}
					}
				}
				const script = sourceFile.getVirtualScript();
				if (!script.document || !script.sourceMap) return;
				const refOffset = script.document.getText().indexOf(SearchTexts.Ref);
				const items = tsLanguageService.doComplete(script.document, script.document.positionAt(refOffset), { includeCompletionsForModuleExports: true });
				for (let item of items) {
					if (item.label !== 'ref')
						continue;
					item = tsLanguageService.doCompletionResolve(item);
					if (!item.data.importModule)
						continue;
					if (!item.additionalTextEdits)
						continue;
					for (const edit of item.additionalTextEdits) {
						const vueLoc = script.sourceMap.targetToSource(edit.range);
						if (!vueLoc)
							continue;
						edits.push({
							range: vueLoc.range,
							newText: edit.newText,
						});
					}
				}
			}
			else {
				// use ref sugar
				for (const refCall of genData.data.refCalls) {
					const left = document.getText().substring(
						desc.scriptSetup.loc.start + refCall.left.start,
						desc.scriptSetup.loc.start + refCall.left.end,
					);
					const right = document.getText().substring(
						desc.scriptSetup.loc.start + refCall.rightExpression.start,
						desc.scriptSetup.loc.start + refCall.rightExpression.end,
					);
					edits.push(TextEdit.replace({
						start: document.positionAt(desc.scriptSetup.loc.start + refCall.start),
						end: document.positionAt(desc.scriptSetup.loc.start + refCall.end),
					}, `ref: ${left} = ${right}`));
					for (const _var of refCall.vars) {
						const varRange = {
							start: document.positionAt(desc.scriptSetup.loc.start + _var.start),
							end: document.positionAt(desc.scriptSetup.loc.start + _var.end),
						};
						const varText = document.getText(varRange);
						const references = _findReferences(document, varRange.start) ?? [];
						for (const reference of references) {
							if (reference.uri !== document.uri)
								continue;
							const refernceRange = {
								start: document.offsetAt(reference.range.start),
								end: document.offsetAt(reference.range.end),
							};
							if (refernceRange.start === desc.scriptSetup.loc.start + _var.start && refernceRange.end === desc.scriptSetup.loc.start + _var.end)
								continue;
							if (refernceRange.start >= desc.scriptSetup.loc.start && refernceRange.end <= desc.scriptSetup.loc.end) {
								const withDotValue = document.getText().substr(refernceRange.end, '.value'.length) === '.value';
								if (withDotValue) {
									edits.push(TextEdit.replace({
										start: reference.range.start,
										end: document.positionAt(refernceRange.end + '.value'.length),
									}, varText));
								}
								else {
									edits.push(TextEdit.replace(reference.range, '$' + varText));
								}
							}
						}
					}
				}
			}
			connection.workspace.applyEdit({ changes: { [document.uri]: edits } });
		}
		if (command === Commands.HTML_TO_PUG) {
			const desc = sourceFile.getDescriptor();
			if (!desc.template) return;
			const lang = desc.template.lang;
			if (lang !== 'html') return;

			const pug = htmlToPug(desc.template.content) + '\n';
			const newTemplate = `<template lang="pug">` + pug;

			let start = desc.template.loc.start - '<template>'.length;
			const end = desc.template.loc.end;
			const startMatch = '<template';

			while (!document.getText(Range.create(
				document.positionAt(start),
				document.positionAt(start + startMatch.length),
			)).startsWith(startMatch)) {
				start--;
				if (start < 0) {
					throw `Can't find start of tag <template>`
				}
			}

			const range = Range.create(
				document.positionAt(start),
				document.positionAt(end),
			);
			const textEdit = TextEdit.replace(range, newTemplate);
			connection.workspace.applyEdit({ changes: { [document.uri]: [textEdit] } });
		}
		if (command === Commands.PUG_TO_HTML) {
			const desc = sourceFile.getDescriptor();
			if (!desc.template) return;
			const lang = desc.template.lang;
			if (lang !== 'pug') return;

			let html = pugToHtml(desc.template.content);
			const newTemplate = `<template>\n` + html;

			let start = desc.template.loc.start - '<template>'.length;
			const end = desc.template.loc.end;
			const startMatch = '<template';

			while (!document.getText(Range.create(
				document.positionAt(start),
				document.positionAt(start + startMatch.length),
			)).startsWith(startMatch)) {
				start--;
				if (start < 0) {
					throw `Can't find start of tag <template>`
				}
			}

			const range = Range.create(
				document.positionAt(start),
				document.positionAt(end),
			);
			const textEdit = TextEdit.replace(range, newTemplate);
			connection.workspace.applyEdit({ changes: { [document.uri]: [textEdit] } });
		}
	}
}