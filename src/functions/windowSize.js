import { onBeforeMount, onUnmounted } from '@vue/composition-api'

export function onWindowResize (callback) {
  onBeforeMount(() => {
    window.addEventListener('resize', callback)
  })
  onUnmounted(() => {
    window.removeEventListener('resize', callback)
  })
}
