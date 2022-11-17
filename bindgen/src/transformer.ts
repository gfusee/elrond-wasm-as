import * as path from 'path';
import { ASTBuilder, Parser, Source, SourceKind } from "assemblyscript/dist/assemblyscript.js";
import { Transform } from 'assemblyscript/dist/transform.js'
import { isEntry } from "visitor-as/dist/utils.js";
import { ContractExporter } from "./contractDecorator.js";
import { EnumExporter } from "./enumDecorator.js";
import { StructExporter } from "./structDecorator.js";
import {CallableExporter} from "./callableDecorator.js";

export default class Transformer extends Transform {
    parser: Parser;
  
    afterParse(parser: Parser): void {
      this.parser = parser;
      const writeFile = this.writeFile;
      const baseDir = this.baseDir;
      let newParser = new Parser(parser.diagnostics);
  
      // Filter for files
      let files = this.parser.sources.filter(s => {
        const isUserSource = (s.sourceKind == SourceKind.USER || s.sourceKind == SourceKind.USER_ENTRY)
        const isElrondLib = s.internalPath.includes('elrond-wasm-as')
        return (isUserSource || isElrondLib)
      });
      // Visit each file
      const contractExporter = new ContractExporter()
      files.forEach((source) => {
        if (source.internalPath.includes("index-stub")) return;

        // Remove from logs in parser
        parser.donelog.delete(source.internalPath);
        parser.seenlog.delete(source.internalPath);
        // Remove from programs sources
        this.parser.sources = this.parser.sources.filter(
          (_source: Source) => _source !== source
        );
        this.program.sources = this.program.sources.filter(
          (_source: Source) => _source !== source
        );

        // Export main singleton class if one is present
        if (source.sourceKind === SourceKind.USER_ENTRY) {
          contractExporter.visitSource(source);
        } else if (source.sourceKind === SourceKind.USER) {
          contractExporter.visitUserNonEntrySource(source)
        }
        (new EnumExporter()).visitSource(source);
        (new StructExporter()).visitSource(source);
        (new CallableExporter()).visitSource(source);
      });

      contractExporter.commit()

      files.forEach((source) => {
        if (source.internalPath.includes("index-stub")) return;

        // Build new Source
        let sourceText = ASTBuilder.build(source);
        const writeOut = false;
        if (writeOut) {
          writeFile(
              posixRelativePath("out", source.normalizedPath),
              sourceText,
              baseDir
          );
        }
        // Parses file and any new imports added to the source
        newParser.parseFile(
            sourceText,
            posixRelativePath(isEntry(source) ? "" : "./", source.normalizedPath),
            isEntry(source)
        );
        let newSource = newParser.sources.pop()!;
        this.program.sources.push(newSource);
        parser.donelog.add(source.internalPath);
        parser.seenlog.add(source.internalPath);
        parser.sources.push(newSource);
      })
    }
}

function posixRelativePath(from: string, to: string): string {
    const relativePath = path.relative(from, to);
    return relativePath.split(path.sep).join(path.posix.sep);
}

