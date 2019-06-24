import { value, watch } from 'vue-function-api'
import prettier from 'prettier/standalone'
import prettierTypescriptParser from 'prettier/parser-typescript'
import { convertScript } from '@/converter'

export function useStoredCode (storageKey, defaultCode) {
  const code = value(localStorage.getItem(storageKey) || defaultCode)

  watch(code, value => {
    localStorage.setItem(storageKey, value)
  })

  return {
    code,
  }
}

export function useCodeConverter (code) {
  const result = value('')
  const error = value(null)

  // Convert code automatically
  watch(code, value => {
    error.value = null
    try {
      // Code mod
      const resultCode = convertScript(value)
      // Prettier
      result.value = prettier.format(resultCode, {
        plugins: [
          prettierTypescriptParser,
        ],
        parser: 'typescript',
        semi: false,
        singleQuote: true,
      })
    } catch (e) {
      console.error(e)
      error.value = e
    }
  })

  return {
    result,
    error,
  }
}
