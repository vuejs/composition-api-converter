<template>
  <div class="code-sandbox">
    <!-- Code editor -->
    <MonacoEditor
      ref="editor"
      class="editor"
      v-model="code"
      theme="vs-dark"
      language="javascript"
    />
    <!-- Result code -->
    <MonacoEditor
      ref="output"
      class="editor"
      v-model="result"
      :options="{
        readOnly: true,
      }"
      theme="vs-dark"
      language="javascript"
    />
  </div>
</template>

<script>
import { value, watch } from 'vue-function-api'
import MonacoEditor from 'vue-monaco'
import prettier from 'prettier/standalone'
import prettierBabelParser from 'prettier/parser-babylon'
import prettierTypescriptParser from 'prettier/parser-typescript'
import { convertScript } from '@/converter'
import { onWindowResize } from '@/functions/windowSize'

const STORAGE_KEY_CODE = 'function-converter:code'

const DEFAULT_CODE = `export default {
  data () {
    return {
      foo: 'bar',
    }
  },

  computed: {
    foofoo () {
      return this.foo.repeat(2)
    }
  }
}`

export default {
  components: {
    MonacoEditor,
  },

  setup () {
    const code = value(localStorage.getItem(STORAGE_KEY_CODE) || DEFAULT_CODE)
    const result = value('')
    const error = value(null)

    // Convert code automatically
    watch(code, value => {
      localStorage.setItem(STORAGE_KEY_CODE, value)
      error.value = null
      try {
        // Code mod
        const resultCode = convertScript(value)
        // Prettier
        result.value = prettier.format(resultCode, {
          plugins: [
            prettierBabelParser,
            prettierTypescriptParser
          ],
          parser: 'babel',
          semi: false,
          singleQuote: true
        })
      } catch (e) {
        console.error(e)
        error.value = e
      }
    })

    onWindowResize(() => {
      [this.$refs.editor, this.$refs.output].forEach(editor => {
        editor.getMonaco().layout()
      })
    })

    return {
      code,
      result,
      error,
    }
  },
}
</script>

<style lang="stylus" scoped>
.code-sandbox
  width 100vw
  height 100vh
  display flex

.editor
  flex 50% 1 1
  height 100%
  overflow hidden
</style>

<style lang="stylus">
.monaco-aria-container
  display none
</style>

