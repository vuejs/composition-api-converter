<template>
  <div id="app">
    <CodeSandbox/>
  </div>
</template>

<script>
import CodeSandbox from './components/CodeSandbox.vue'

export default {
  name: 'App',
  components: {
    CodeSandbox,
  },
}
</script>

<style lang="stylus">
body {
  margin: 0;
  font-family: Avenir, Helvetica, Arial, sans-serif;
}
</style>
