import { ref } from 'vue'

export const activeConversationId = ref('default')
const nativeIpc = (window as any).require('electron').ipcRenderer
export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]) {
    if (channel.startsWith('memory:') || channel.startsWith('sessions:') || channel.startsWith('documents:') || channel.startsWith('chat:') || channel === 'app:reset')
      args.push({ conversationId: activeConversationId.value })
    return nativeIpc.invoke(channel, ...args)
  },
  sendSync(channel: string, ...args: unknown[]) { return nativeIpc.sendSync(channel, ...args) },
  on: nativeIpc.on.bind(nativeIpc),
  removeListener: nativeIpc.removeListener.bind(nativeIpc),
}
