//@ts-nocheck
import {
    ASTBuilder,
    ClassDeclaration,
    CommonFlags,
    FieldDeclaration,
    ImportStatement,
    MethodDeclaration,
    NamedTypeNode,
    Source,
    SourceKind,
    NodeKind
} from "assemblyscript/dist/assemblyscript.js";
import {SimpleParser, TransformVisitor} from "visitor-as";
import {isEntry} from "visitor-as/dist/utils.js";
import {
    addElrondWasmASImportToSourceIfMissing,
    getSourceElrondWasmASImports,
    removeAllElrondWasmImports
} from "./utils/parseUtils.js";

export class ContractExporter extends TransformVisitor {

    sb: string[] = []
    sbImports: string[] = []

    newMethods: string[] = []

    get className(): string {
        if (this.classSeen === null) {
            throw new Error('className is null')
        }
        return ASTBuilder.build(this.classSeen.name)
    }

    private classSeen: ClassDeclaration | null = null

    private allUserClasses: ClassDeclaration[] = []
    private classesExtended: NamedTypeNode[] = []

    visitFieldDeclaration(node: FieldDeclaration): FieldDeclaration {
        if (node.is(CommonFlags.PRIVATE) || node.is(CommonFlags.PROTECTED)) {
            //TODO : verify that type is nullable and default assigned to null
            return node
        }
        let name = ASTBuilder.build(node.name)
        let typeName = ASTBuilder.build(node.type!)

        if (!node.is(CommonFlags.DEFINITELY_ASSIGNED)) {
            node.flags |= CommonFlags.DEFINITELY_ASSIGNED
        }

        node.name.text = `__${name}`

        this.sbImports.push("Mapping")

        this.newMethods.push(
            `
            get ${name}(): ${typeName} {
              return (new Mapping<${typeName}>(new StorageKey(ElrondString.fromString('${name}')))).get()
            }
            `
        )

        this.newMethods.push(
            `
            set ${name}(value: ${typeName}): void {
                (new Mapping<${typeName}>(new StorageKey(ElrondString.fromString('${name}')))).set(value)
            }
            `
        )

        return node
    }

    visitMethodDeclaration(node: MethodDeclaration): MethodDeclaration {
        if (node.is(CommonFlags.PRIVATE) || node.is(CommonFlags.PROTECTED)) {
            return node
        }

        if (node.is(CommonFlags.ABSTRACT)) {
            if (ASTBuilder.build(node.signature.returnType).includes('Mapping')) {
                this.parseStorageMethod(node, this.classSeen)
                return node
            } else {
                throw new Error('TODO : unknown abstract method type')
            }
        }


        let name = ASTBuilder.build(node.name)
        const isConstructor = name == 'constructor'

        if (isConstructor) {
            const initName = 'init'
            let nodeText = ASTBuilder.build(node)
            nodeText = nodeText.replace(/constructor\((.*)\)/, 'init($1): void')
            nodeText = nodeText.replace(/super\((.*)\)\s*;?/, '')
            this.newMethods.push(nodeText)
            name = initName

            this.classSeen.members = this.classSeen.members.filter((m) => m !== node)
        }

        const returnTypeName = ASTBuilder.build(node.signature.returnType)
        const params = node.signature.parameters

        const isOnlyOwner = ContractExporter.hasOnlyOwnerDecorator(node)
        let endpointCall = ''
        if (isOnlyOwner) {
            endpointCall = `
            contract.blockchain.assertCallerIsContractOwner();
            `
        }
        let argHasOptionalValue = false

        if (params.length == 0) {
            endpointCall = `contract.${name}()`
        } else {
            params.forEach((param, index, _) => {
                let paramName = ASTBuilder.build(param.name)
                let paramType = ASTBuilder.build(param.type)
                if (paramType.includes('OptionalValue<')) {
                    if (!argHasOptionalValue) {
                        endpointCall += `
                const numArguments = ArgumentApi.getNumberOfArguments();\n
                `
                        argHasOptionalValue = true
                    }

                    endpointCall += `
              let ${paramName}: ${paramType} = BaseManagedType.dummy<${paramType}>()
              if (numArguments >= ${index + 1}) {
                ${paramName} = ${paramName}.utils.fromArgumentIndex(${index})
              } else {
                ${paramName} = ${paramName}.utils.fromNull()
              }
              `
                } else {
                    if (paramType.includes('MultiValueEncoded<')) {
                        if (index === params.length - 1) {
                            endpointCall += `
                            const ${paramName} = BaseManagedType.dummy<${paramType}>().${paramName}.utils.fromArgumentIndex(${index})
                            `
                        } else {
                            throw new Error('TODO : MultiValueEncoded should be the last argument')
                        }
                    } else {
                        if (argHasOptionalValue) {
                            throw new Error('TODO : error OptionalValue required')
                        } else {
                            if (!ContractExporter.isTypeUserImported(this.classSeen.range.source, paramType)) {
                                this.sbImports.push(paramType)
                            }

                            endpointCall = endpointCall + `
                const ${paramName}: ${paramType} = BaseManagedType.dummy<${paramType}>().utils.fromArgumentIndex(${index});
                `
                        }
                    }
                }

            })

            endpointCall = endpointCall + `contract.${name}(` + params.map(p => ASTBuilder.build(p.name)).join(', ') + ')'
        }

        endpointCall = endpointCall + (returnTypeName == 'void' || returnTypeName.length == 0 ? ';' : '.utils.finish();')

        let expression = `
        const contract = __initContract();
        ${endpointCall}
        `

        this.sb.push(`
        export function ${name}(): void {
            ${expression}
        }
        `)

        return node
    }

    visitClassDeclaration(node: ClassDeclaration): ClassDeclaration {
        if (node.range.source.sourceKind === SourceKind.USER || node.range.source.sourceKind === SourceKind.USER_ENTRY) {
            const allUserClassesNames = this.allUserClasses.map((c) => ASTBuilder.build(c.name))
            if (!allUserClassesNames.includes(ASTBuilder.build(node.name))) {
                this.allUserClasses.push(node)
            }
        }

        const isContract = isEntry(node) && ContractExporter.hasContractDecorator(node)
        const isModule = !isEntry(node) && ContractExporter.hasModuleDecorator(node) //TODO : Make @module unnecessary?

        if (isContract || isModule) {
            if (this.classSeen !== null) {
                return node
            }

            if (node.extendsType === null) {
                throw new Error('TODO : contract class should extends something')
            }

            if (ASTBuilder.build(node.extendsType) !== "ContractBase") {
                this.classesExtended.push(node.extendsType)
            }

            this.classSeen = node

            node.flags &= ~CommonFlags.ABSTRACT

            const requiredImports = ["ElrondString", "ArgumentApi", "ContractBase", "StorageKey", "BaseManagedType"].concat(this.sbImports)

            for (const requiredImport of requiredImports) {
                this.sbImports.push(requiredImport)
            }

            this.visit(node.members)

            node.members = node.members.filter(n => {
                if (n instanceof MethodDeclaration) {
                    const name = ASTBuilder.build(n.name)
                    return name !== 'constructor'
                }

                return true
            })

            this.newMethods.forEach(m => {
                let declaration = SimpleParser.parseClassMember(
                    m,
                    node
                )

                node.members.push(declaration)
            })
        }

        return node
    }

    commit() {
        let extendedClassesNames = this.classesExtended.map((c) => ASTBuilder.build(c))
        let allUserClassesIndex = 0
        while (allUserClassesIndex < this.allUserClasses.length) {
            const c = this.allUserClasses[allUserClassesIndex]
            const cName = ASTBuilder.build(c.name)
            while (extendedClassesNames.includes(cName)) {
                allUserClassesIndex = -1 //reset loop
                const exporter = new ContractExporter()

                exporter.visitSource(c.range.source)
                extendedClassesNames.push(...exporter.classesExtended.map((newClass) => {
                    return ASTBuilder.build(newClass)
                }))
                this.sb.push(...exporter.sb)
                this.sbImports.push(...exporter.sbImports)
                extendedClassesNames = extendedClassesNames.filter((name) =>
                    name !== cName
                )
            }
            allUserClassesIndex++
        }

        this.sb.push(
            `
          @global
          let __CURRENT_CONTRACT: ${this.className} | null = null
          `
        )
        this.sb.push(
            `
          @inline
          function __initContract(): ${this.className} {
              __CURRENT_CONTRACT = new ${this.className}();
              return __CURRENT_CONTRACT!;
          }
            `
        )

        this.classSeen.range.source.statements.push(...this.sb.map((s) => SimpleParser.parseTopLevelStatement(s)))

        this.sbImports.forEach((importToAdd) => {
            addElrondWasmASImportToSourceIfMissing(this.classSeen.range.source, importToAdd)
        })
    }

    private parseStorageMethod(node: MethodDeclaration, classDeclaration: ClassDeclaration) {
        const name = ASTBuilder.build(node.name)

        classDeclaration.members = classDeclaration.members.filter(m => m !== node)

        const returnTypeName = ASTBuilder.build(node.signature.returnType)

        let newSignatureParameters = ''
        let additionnalsKeysAppend = ''
        node.signature.parameters.forEach((p, index) => {
            const paramName = ASTBuilder.build(p.name)
            const typeName = ASTBuilder.build(p.type)
            const isLast = index + 1 === node.signature.parameters.length

            newSignatureParameters += `${paramName}: ${typeName}` + (isLast ? '' : ', ')
            additionnalsKeysAppend += `key.appendItem<${typeName}>(${paramName});`
        })

        let newBody = `
      const key = new StorageKey(ElrondString.fromString('${name}'));
      ${additionnalsKeysAppend}
      const result = instantiate<${returnTypeName}>(key);\n
      `

        this.newMethods.push(`
      ${name}(${newSignatureParameters}): ${returnTypeName} {
        ${newBody}

        return result
      }
      `)
    }

    // Allow to register classes in this.allUserClasses via visitClassDeclaration
    visitUserNonEntrySource(node: Source) {
        super.visitSource(node)
    }

    visitSource(node: Source): Source {
        const newSource = super.visitSource(node)

        this.sbImports.forEach((importToAdd) => {
            addElrondWasmASImportToSourceIfMissing(newSource, importToAdd)
        })

        return newSource
    }

    static isTypeUserImported(source: Source, type: string): boolean {
        const imports = source.statements.filter((s) => s.kind === NodeKind.IMPORT) as ImportStatement[]

        for (const i of imports) {
            let isTypeImported = false
            for (const declaration of i.declarations) {
                if (ASTBuilder.build(declaration) === type) {
                    isTypeImported = true
                    break
                }
            }
            if (isTypeImported) {
                return ASTBuilder.build(i.path) !== '"@gfusee/elrond-wasm-as"'
            }
        }

        return false
    }

    static hasContractDecorator(node: ClassDeclaration): boolean {
        const decorators = node.decorators ?? []
        const decoratorsNames = decorators.map(d => ASTBuilder.build(d.name))

        return decoratorsNames.includes('contract')
    }

    static hasModuleDecorator(node: ClassDeclaration): boolean {
        const decorators = node.decorators ?? []
        const decoratorsNames = decorators.map(d => ASTBuilder.build(d.name))

        return decoratorsNames.includes('module')
    }

    static hasOnlyOwnerDecorator(node: MethodDeclaration): boolean {
        let decorators = node.decorators ?? []

        return decorators.map(d => ASTBuilder.build(d.name)).includes('onlyOwner')
    }

}