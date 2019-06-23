import { onCreated, onDestroyed } from 'vue-function-api'

export function onWindowResize (callback) {
  onCreated(() => {
    window.addEventListener('resize', callback)
  })
  onDestroyed(() => {
    window.removeEventListener('resize', callback)
  })
}
