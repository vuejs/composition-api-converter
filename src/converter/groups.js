import { print, visit, types } from 'recast'
import { kebab, pascal } from 'case'
import levenshtein from 'js-levenshtein'
import stemmer from 'stemmer'

const { namedTypes } = types

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
export function groupStatements (nodes, setupVariables) {
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

  const ungroupedNodes = []

  // Remove duplicates
  for (const node of wordedNodes) {
    let bestGroup
    const relevantGroups = []
    let isInGroup = false
    for (const group of groups) {
      if (group.nodes.has(node)) {
        isInGroup = true
        if (!bestGroup || group.score > bestGroup.score) {
          bestGroup = group
        }
        relevantGroups.push(group)
      }
    }

    if (isInGroup) {
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
    } else {
      ungroupedNodes.push(node)
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

  if (ungroupedNodes.length || otherNodes.length) {
    if (groups.length) {
      result.push(`// Misc`)
    }
    result.push(...ungroupedNodes, ...otherNodes)
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
