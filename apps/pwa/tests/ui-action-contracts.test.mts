import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

test("every rendered button has a click action or an explicit submit action", async () => {
  const appDirectory = new URL("../app/", import.meta.url);
  const files = (await readdir(appDirectory))
    .filter(file => file.endsWith(".tsx"))
    .sort();

  for (const file of files) {
    const sourceText = await readFile(new URL(file, appDirectory), "utf8");
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (opening.tagName.getText(source) === "button") {
          const attributes = new Map(
            opening.attributes.properties
              .filter(ts.isJsxAttribute)
              .map(attribute => [
                attribute.name.getText(source),
                attribute.initializer?.getText(source) ?? "",
              ]),
          );
          const line = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1;
          const hasClickAction = Boolean(attributes.get("onClick"));
          const hasSubmitAction = attributes.get("type")?.includes("submit") ?? false;
          assert.ok(
            hasClickAction || hasSubmitAction,
            `${path.join("app", file)}:${line} renders a button without a click or submit action`,
          );
          if (hasSubmitAction) {
            let parent: ts.Node | undefined = node.parent;
            let submittingForm = false;
            while (parent) {
              if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === "form") {
                submittingForm = parent.openingElement.attributes.properties.some(attribute =>
                  ts.isJsxAttribute(attribute) &&
                  attribute.name.getText(source) === "onSubmit" &&
                  attribute.initializer !== undefined
                );
                break;
              }
              parent = parent.parent;
            }
            assert.ok(
              submittingForm,
              `${path.join("app", file)}:${line} renders a submit button without an owning onSubmit form`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
