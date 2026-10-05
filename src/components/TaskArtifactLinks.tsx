import { useState } from 'react'
import { http } from '@/api/client'
import type { Message } from '@/types'
import { downloadTaskArtifact } from '@/lib/task-artifacts'

export function TaskArtifactLinks({delivery}:{delivery:NonNullable<Message['taskDelivery']>}) {
  const [error,setError]=useState('')
  const download=async(id:string)=>{
    try {
      const artifact=await http<{content:string;mediaType:string;hash:string}>(`/tasks/artifacts/${encodeURIComponent(id)}`)
      downloadTaskArtifact(id, artifact)
      setError('')
    }catch(failure){setError(failure instanceof Error?failure.message:'产物读取失败')}
  }
  return <div className="mt-2 text-xs text-ink-700" aria-label="任务交付">
    {delivery.artifactVersionIds.map((id,index)=><button type="button" className="mr-3 underline" key={id} onClick={()=>{void download(id)}}>产物 {index+1}</button>)}
    {delivery.limitations.map(text=><p key={text}>{text}</p>)}
    {error && <p role="alert">{error}</p>}
  </div>
}
