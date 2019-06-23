import { parse, print, types, visit } from 'recast'
import { camel, kebab, pascal } from 'case'
import levenshtein from 'js-levenshtein'
import stemmer from 'stemmer'

const { namedTypes, builders } = types

const LIFECYCLE_HOOKS = [
  'beforeCreate',
  'created',
  'beforeMount',
  'mounted',
  'beforeUpdate',
  'updated',
  'beforeDestroy',
  'descroyed',
  'activated',
  'deactivated',
]

const ROUTER_HOOKS = [
  'beforeRouteEnter',
  'beforeRouteUpdate',
  'beforeRouteLeave',
]

export function convertScript(script) {
  const ast = parse(script)
  /** @type {import('recast').types.namedTypes.ExportDefaultDeclaration} */
  const componentDefinition = ast.program.body.find(node =>
    namedTypes.ExportDefaultDeclaration.check(node),
  )
  if (!componentDefinition) {
    throw new Error(`Default export not found`)
  }
  console.log(componentDefinition)

  const removeOption = (option) => {
    const index = componentDefinition.declaration.properties.indexOf(option)
    componentDefinition.declaration.properties.splice(index, 1)
  }

  const newImports = {
    vue: [],
    vueRouter: [],
  }
  const setupReturn = builders.returnStatement(
    builders.objectExpression([]),
  )
  const setupFn = builders.functionExpression(
    null,
    [],
    builders.blockStatement([]),
  )
  
  /** @type {import('recast').types.namedTypes.Property[]} */
  const options = componentDefinition.declaration.properties.filter(node =>
    namedTypes.Property.check(node),
  )

  /** @type {string[]} */
  const valueWrappers = []

  /** @type {string[]} */
  const setupVariables = []

  // Data
  const dataOption = options.find(node => node.key.name === 'data')
  if (dataOption) {
    let objectProperties
    if (namedTypes.FunctionExpression.check(dataOption.value)) {
      const returnStatement = dataOption.value.body.body.find(node =>
        namedTypes.ReturnStatement.check(node),
      )
      if (!returnStatement) {
        throw new Error(`No return statement found in data option`)
      }
      objectProperties = returnStatement.argument.properties
    } else if (namedTypes.ObjectExpression.check(dataOption.value)) {
      objectProperties = dataOption.value.properties
    }
    /** @type {{ name: string, value: any, state: boolean }[]} */
    const dataProperties = objectProperties.map(node => ({
      name: node.key.name,
      value: node.value,
      state: namedTypes.ObjectExpression.check(node.value),
    }))
    if (dataProperties.length) {
      if (dataProperties.some(p => !p.state)) {
        newImports.vue.push('value')
      }
      if (dataProperties.some(p => p.state)) {
        newImports.vue.push('state')
      }
      for (const property of dataProperties) {
        setupFn.body.body.push(
          builders.variableDeclaration('const', [
            builders.variableDeclarator(
              builders.identifier(property.name),
              builders.callExpression(
                builders.identifier(property.state ? 'state' : 'value'),
                [property.value],
              ),
            ),
          ]),
        )
        setupReturn.argument.properties.push(
          builders.identifier(property.name),
        )
        setupVariables.push(property.name)
        if (!property.state) {
          valueWrappers.push(property.name)
        }
      }
    }
    removeOption(dataOption)
  }

  // Computed
  const computedOption = options.find(property => property.key.name === 'computed')
  if (computedOption) {
    newImports.vue.push('computed')
    for (const property of computedOption.value.properties) {
      let args
      if (namedTypes.FunctionExpression.check(property.value)) {
        args = [builders.arrowFunctionExpression([], property.value.body)]
      } else if (namedTypes.ObjectExpression.check(property.value)) {
        const getFn = property.value.properties.find(p => p.key.name === 'get')
        const setFn = property.value.properties.find(p => p.key.name === 'set')
        args = [
          getFn ? builders.arrowFunctionExpression([], getFn.value.body) : null,
          setFn ? builders.arrowFunctionExpression([], setFn.value.body) : undefined,
        ]
      }
      setupFn.body.body.push(
        builders.variableDeclaration('const', [
          builders.variableDeclarator(
            builders.identifier(property.key.name),
            builders.callExpression(
              builders.identifier('computed'),
              args,
            ),
          ),
        ]),
      )
      setupReturn.argument.properties.push(
        builders.identifier(property.key.name),
      )
      setupVariables.push(property.key.name)
      valueWrappers.push(property.key.name)
    }
    removeOption(computedOption)
  }

  // Watch
  const watchOption = options.find(property => property.key.name === 'watch')
  if (watchOption) {
    newImports.vue.push('watch')
    for (const property of watchOption.value.properties) {
      let firstArg
      if (namedTypes.Literal.check(property.key)) {
        const parts = property.key.value.split('.')
        if (valueWrappers.includes(parts[0])) {
          parts.splice(1, 0, 'value')
        }
        let expression
        for (const part of parts) {
          if (!expression) {
            expression = builders.identifier(part)
          } else {
            expression = builders.memberExpression(expression, builders.identifier(part))
          }
        }
        firstArg = builders.arrowFunctionExpression([], expression, true)
      } else {
        firstArg = builders.identifier(property.key.name)
      }

      let args = [firstArg]
      // Handler only as direct function
      if (namedTypes.FunctionExpression.check(property.value)) {
        args.push(builders.arrowFunctionExpression(property.value.params, property.value.body))
        // Immediate is false by default
        args.push(builders.objectExpression([
          builders.objectProperty(builders.identifier('lazy'), builders.literal(true)),
        ]))
      } else if (namedTypes.ObjectExpression.check(property.value)) {
        // Object notation
        const handler = property.value.properties.find(p => p.key.name === 'handler')
        args.push(builders.arrowFunctionExpression(handler.value.params, handler.value.body))
        const options = []
        for (const objectProperty of property.value.properties) {
          if (objectProperty.key.name === 'immediate') {
            // Convert to `lazy` option (and negate value)
            let value
            let addLazyOption = false
            if (namedTypes.Literal.check(objectProperty.value)) {
              const lazy = !objectProperty.value.value
              value = builders.literal(lazy)
              addLazyOption = lazy
            } else {
              value = builders.unaryExpression('!', objectProperty.value)
              addLazyOption = true
            }
            if (addLazyOption) {
              options.push(builders.objectProperty(builders.identifier('lazy'), value))
            }
          } else if (objectProperty.key.name !== 'handler') {
            options.push(objectProperty)
          }
        }
        if (options.length) {
          args.push(builders.objectExpression(options))
        }
      }
      setupFn.body.body.push(builders.expressionStatement(
        builders.callExpression(
          builders.identifier('watch'),
          args,
        )
      ))
    }
    removeOption(watchOption)
  }

  // Methods
  const methodsOption = options.find(property => property.key.name === 'methods')
  if (methodsOption) {
    for (const property of methodsOption.value.properties) {
      setupFn.body.body.push(
        builders.variableDeclaration('const', [
          builders.variableDeclarator(
            builders.identifier(property.key.name),
            builders.arrowFunctionExpression([], property.value.body),
          ),
        ]),
      )
      setupReturn.argument.properties.push(
        builders.identifier(property.key.name),
      )
      setupVariables.push(property.key.name)
    }
    removeOption(methodsOption)
  }

  // Lifecycle hooks
  const processHooks = (hookList, importList) => {
    for (const option of options) {
      if (hookList.includes(option.key.name)) {
        const hookName = camel(`on_${option.key.name}`)
        importList.push(hookName)
        setupFn.body.body.push(builders.expressionStatement(
          builders.callExpression(
            builders.identifier(hookName),
            [builders.arrowFunctionExpression(option.value.params, option.value.body)],
          )
        ))
        removeOption(option)
      }
    }
  }
  processHooks(LIFECYCLE_HOOKS, newImports.vue)
  processHooks(ROUTER_HOOKS, newImports.vueRouter)

  // Remove `this`
  transformThis(setupFn.body.body, setupVariables, valueWrappers)

  // Group statements heuristically
  setupFn.body.body = groupStatements(setupFn.body.body, setupVariables)

  setupFn.body.body.push(setupReturn)
  componentDefinition.declaration.properties.push(
    builders.methodDefinition(
      'method',
      builders.identifier('setup'),
      setupFn,
    ),
  )

  // Imports
  const importStatements = []
  for (const key in newImports) {
    const pkg = kebab(key)
    if (newImports[key].length) {
      const specifiers = newImports[key].map(i => builders.importSpecifier(builders.identifier(i)))
      const importDeclaration = builders.importDeclaration(specifiers, builders.stringLiteral(pkg))
      importStatements.push(importDeclaration)
    }
  }
  if (importStatements.length) {
    ast.program.body.splice(0, 0, ...importStatements, `\n`)
  }

  return print(ast).code
}

/**
 * @param {import('recast').types.ASTNode} node
 * @param {string[]} setupVariables
 * @param {string[]} valueWrappers
 */
function transformThis (node, setupVariables, valueWrappers) {
  visit(node, {
    visitMemberExpression (path) {
      if (namedTypes.ThisExpression.check(path.value.object) &&
        setupVariables.includes(path.value.property.name)) {
        // Remove this
        let parentObject = builders.identifier(path.value.property.name)
        // Value wrapper
        if (valueWrappers.includes(path.value.property.name)) {
          parentObject = builders.memberExpression(parentObject, builders.identifier('value'))
        }
        path.replace(parentObject)
      }
      this.traverse(path)
    },
  })
}

/**
 * @typedef Word
 * @prop {string} value
 * @prop {number} score
 */

/**
 * @typedef StatementGroup
 * @prop {Set<import('recast').types.ASTNode>} nodes
 * @prop {number} score
 * @prop {string[]} declarations
 * @prop {Set<string>} dependencies
 * @prop {number} usageScore
 */

/**
 * @param {import('recast').types.ASTNode[]} nodes
 * @param {string[]} setupVariables
 */
function groupStatements (nodes, setupVariables) {
  /** @type {StatementGroup[]} */
  let groups = []

  // Classify nodes
  const wordedNodes = []
  const otherNodes = []
  for (const node of nodes) {
    if (getStatementWords(node, setupVariables).length) {
      wordedNodes.push(node)
    } else {
      otherNodes.push(node)
    }
  }

  // Group nodes together
  for (const nodeA of wordedNodes) {
    for (const nodeB of wordedNodes) {
      if (nodeA !== nodeB) {
        const score = getStatementGroupScore(nodeA, nodeB, setupVariables)
        if (score > 0) {
          let group = groups.find(
            g => g.score === score && (g.nodes.has(nodeA) || g.nodes.has(nodeB))
          )
          if (!group) {
            group = {
              nodes: new Set(),
              score,
              declarations: [],
              dependencies: new Set(),
              usageScore: 0,
            }
            groups.push(group)
          }

          [nodeA, nodeB].forEach(node => {
            group.nodes.add(node)
          })
        }
      }
    }
  }

  // Remove duplicates
  for (const node of wordedNodes) {
    let bestGroup
    const relevantGroups = []
    for (const group of groups) {
      if (group.nodes.has(node)) {
        if (!bestGroup || group.score > bestGroup.score) {
          bestGroup = group
        }
        relevantGroups.push(group)
      }
    }
    // Remove the duplicated node in the not best groups
    for (const group of relevantGroups) {
      if (group !== bestGroup) {
        group.nodes.delete(node)

        // Don't leave groups with only one statement
        if (group.nodes.size === 1) {
          bestGroup.nodes.add(group.nodes.values().next().value)
          group.nodes.clear()
        }
      }
    }
  }

  // Variables declarations & dependency identifiers
  for (const group of groups) {
    for (const node of group.nodes) {
      const varName = mayGetVariableDeclarationName(node)
      if (varName) {
        group.declarations.push(varName)
      }

      visit(Array.from(group.nodes), {
        visitIdentifier (path) {
          let identifier = path.value.name
          if (setupVariables.includes(identifier) && !group.declarations.includes(identifier)) {
            group.dependencies.add(identifier)
          }
          this.traverse(path)
        },
      })
    }
  }

  // Used by other group stats
  for (const groupA of groups) {
    for (const declaration of groupA.declarations) {
      for (const groupB of groups) {
        if (groupA !== groupB) {
          if (groupB.dependencies.has(declaration)) {
            groupA.usageScore++
          }
        }
      }
    }
  }

  // Sort groups
  groups = groups
    .filter(g => g.nodes.size)
    .sort((a, b) => b.score - a.score)
    .sort((a, b) => {
      const declarationsA = a.declarations.length
      const dependenciesA = a.dependencies.size
      const scoreA = declarationsA - dependenciesA
      const declarationsB = b.declarations.length
      const dependenciesB = b.dependencies.size
      const scoreB = declarationsB - dependenciesB
      if (scoreA === scoreB) {
        return declarationsB - declarationsA
      }
      return scoreB - scoreA
    })
    .sort((a, b) => b.usageScore - a.usageScore)

  // Debug
  for (const group of groups) {
    console.log(
      'group score:', group.score,
      'statements:', Array.from(group.nodes).map(node => ({ code: print(node).code, words: JSON.stringify(wordNodeCache.get(node)) })),
      'declarations:', group.declarations,
      'dependencies:', group.dependencies,
      'usage score:', group.usageScore
    )
  }

  const result = []

  let index = 0
  for (const group of groups) {
    // result.push(`// Group ${++index} (score: ${group.score}, dec: ${group.declarations.length}, deps: ${group.dependencies.size}, usage: ${group.usageScore})`)
    result.push(`// ${generateGroupName(group, index)}`)
    result.push(...group.nodes)
    index++
  }

  if (otherNodes.length) {
    result.push(`// Misc`, ...otherNodes)
  }

  return result
}

/**
 * Returns a measure of how close two statements should be
 * @param {import('recast').types.ASTNode} nodeA
 * @param {import('recast').types.ASTNode} nodeB
 * @param {string[]} variables
 */
function getStatementGroupScore (nodeA, nodeB, variables) {
  const wordsA = getStatementWords(nodeA, variables)
  const wordsB = getStatementWords(nodeB, variables)
  let score = 0
  for (const wordA of wordsA) {
    for (const wordB of wordsB) {
      const distance = levenshtein(wordA.value, wordB.value)
      if (distance <= 1) {
        score += (wordA.score + wordB.score) / 2
      }
    }
  }
  return score
}

function mayGetVariableDeclarationName (node) {
  if (namedTypes.VariableDeclaration.check(node)) {
    return node.declarations[0].id.name
  }
}

const wordNodeCache = new Map()
const wordCache = new Map()

/**
 * @param {import('recast').types.ASTNode} node
 * @param {string[]} setupVariables
 * @returns {Word[]}
 */
function getStatementWords (node, setupVariables) {
  if (!wordNodeCache.has(node)) {
    /** @type {Word[]} */
    let words = []
    // Variable
    let varName = mayGetVariableDeclarationName(node)
    if (varName) {
      words.push({ value: varName, score: 1 })
    } else {
      // Contained identifiers
      visit(node, {
        visitIdentifier (path) {
          let identifier = path.value.name
          if (setupVariables.includes(identifier) && !words.includes(identifier)) {
            words.push({ value: identifier, score: 1 })
          }
          this.traverse(path)
        },
      })
    }

    // Processing
    const allWords = words.map(n => n.value).join('|')
    if (wordCache.has(allWords)) {
      words = wordCache.get(allWords)
    } else {
      words = processWords(words, true)
      wordCache.set(allWords, words)
    }
    wordNodeCache.set(node, words)
    return words
  } else {
    return wordNodeCache.get(node)
  }
}

/**
 * Separate & stem words
 * @param {Word[]} words
 * @param {boolean} stemming
 * @returns {Word[]}
 */
function processWords (words, stemming = false) {
  return words.reduce((list, word) => {
    list.push(...kebab(word.value).split('-').map(value => ({
      value: stemming ? stemmer(value) : value,
      score: word.score,
    })))
    return list
  }, [])
}

/**
 * @param {StatementGroup} group
 * @param {number} index
 */
function generateGroupName (group, index) {
  if (group.declarations) {
    const vars = {}
    // Count variable identifiers
    visit(Array.from(group.nodes), {
      visitIdentifier (path) {
        let identifier = path.value.name
        if (group.declarations.includes(identifier)) {
          const words = processWords([{ value: identifier, score: 1 }])
          for (const word of words) {
            if (!vars[word.value]) {
              vars[word.value] = 1
            } else {
              vars[word.value]++
            }
          }
        }
        this.traverse(path)
      },
    })
    // Sort by count
    let sortedVars = Object.keys(vars)
      .filter(v => vars[v] > 1)
      .sort((a, b) => vars[b] - vars[a])
    // Cache stemmed variable names
    const stemmedVars = {}
    for (const v of sortedVars) {
      stemmedVars[v] = stemmer(v)
    }
    // Heuristic word removal
    sortedVars = sortedVars.filter(a => {
      for (const b of sortedVars) {
        if (a !== b && (
          // If stemmed names are identical, we keep only the shortest one
          (stemmedVars[a] === stemmedVars[b] && a.length > b.length) ||
          // If the names are close, we keep only the most used one
          (vars[a] < vars[b] && levenshtein(stemmedVars[a], stemmedVars[b]) <= 1)
        )) {
          return false
        }
      }
      return true
    })
    // Final formatting
    return sortedVars.map(v => pascal(v)).join(' ')
  }

  // Default dumb name
  return `Group #${index + 1}`
}
