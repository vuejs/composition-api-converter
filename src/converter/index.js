import { parse, print, types, visit } from 'recast'
import { camel } from 'case'

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

  transformThis(setupFn.body.body, valueWrappers)

  setupFn.body.body.push(setupReturn)
  componentDefinition.declaration.properties.push(
    builders.methodDefinition(
      'method',
      builders.identifier('setup'),
      setupFn,
    ),
  )

  // Imports
  if (newImports.length) {
    const specifiers = newImports.map(i => builders.importSpecifier(builders.identifier(i)))
    const importDeclaration = builders.importDeclaration(specifiers, builders.stringLiteral('vue'))
    ast.program.body.splice(0, 0, importDeclaration, `\n`)
  }

  return print(ast).code
}

/**
 * @param {import('recast').types.ASTNode} node
 * @param {string[]} valueWrappers
 */
function transformThis (node, valueWrappers) {
  visit(node, {
    visitMemberExpression (path) {
      if (namedTypes.ThisExpression.check(path.value.object)) {
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
