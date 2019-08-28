<template>
  <div class="code-sandbox">
    <!-- Code editor -->
    <MonacoEditor
      ref="editor"
      v-model="code"
      class="editor"
      theme="vs-dark"
      language="javascript"
    />
    <!-- Result code -->
    <MonacoEditor
      ref="output"
      v-model="result"
      class="editor"
      :options="{
        readOnly: true,
      }"
      theme="vs-dark"
      language="javascript"
    />
  </div>
</template>

<script>
import MonacoEditor from 'vue-monaco'
import { onWindowResize } from '@/functions/windowSize'
import { useStoredCode, useCodeConverter } from '@/functions/code'

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

  setup (props, context) {
    const { code } = useStoredCode(STORAGE_KEY_CODE, DEFAULT_CODE)
    const { result, error } = useCodeConverter(code)

    onWindowResize(() => {
      [context.refs.editor, context.refs.output].forEach(editor => {
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
