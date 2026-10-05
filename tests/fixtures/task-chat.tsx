import React from 'react'
import {createRoot} from 'react-dom/client'
import {TaskContextPanel} from '../../src/components/TaskContextPanel'
import {useAuth} from '../../src/stores/auth'
import {sendUserMessage,retryFailedMessage,useMessages} from '../../src/stores/messages'

useAuth.getState().setSession('task-ui-test',{id:'task-ui-owner',email:'task-ui@test.local',name:'Task UI owner'},'task-ui-test')
const channelId='task-ui-channel'
const EMPTY_MESSAGES:ReturnType<typeof useMessages.getState>['byConvo'][string]=[]
function Shell(){
  const messages=useMessages(state=>state.byConvo[channelId]??EMPTY_MESSAGES)
  const failed=messages.find(message=>message.failed)
  return <main>
    <div id="desktop"><TaskContextPanel channelId={channelId}/></div>
    <div id="mobile"><TaskContextPanel channelId={channelId}/></div>
    <button id="send" onClick={()=>{void sendUserMessage(channelId,'Task UI approved supplement')}}>发送测试消息</button>
    <button id="retry" disabled={!failed} onClick={()=>{if(failed)void retryFailedMessage(channelId,failed.id)}}>重试测试消息</button>
    <output id="messages">{JSON.stringify(messages.map(message=>({id:message.id,failed:message.failed,pending:message.pending,taskReference:message.taskReference})))}</output>
  </main>
}
createRoot(document.getElementById('root')!).render(<Shell/> )
