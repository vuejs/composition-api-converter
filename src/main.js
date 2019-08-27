import Vue from 'vue'
import CompositionApi from '@vue/composition-api'
import App from './App.vue'

Vue.config.productionTip = false

Vue.use(CompositionApi)

new Vue({
  render: h => h(App),
}).$mount('#app')
