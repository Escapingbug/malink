import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { NewSessionDialog, type NewSessionInput } from '../app/NewSessionDialog'
import { gatewayProjectOwner } from '../app/projectCatalog'
import '../app/globals.css'

const extension = {
  id: 'has-privacy',
  name: 'HaS privacy',
  description: 'Sanitize prompts locally before Agent egress and restore Agent output locally.',
  version: '1',
  settings: [
    {
      id: 'contextId',
      type: 'text' as const,
      label: 'Privacy context',
      required: true,
      placeholder: 'payroll-system-id',
    },
    {
      id: 'reviewRequired',
      type: 'boolean' as const,
      label: 'Review every sanitized prompt before sending',
      defaultValue: true,
    },
  ],
}

function Harness() {
  const [open, setOpen] = useState(true)
  const [submission, setSubmission] = useState<NewSessionInput | null>(null)
  const gateway = gatewayProjectOwner('gateway-e2e', 'Gateway simulator')
  return (
    <>
      <NewSessionDialog
        open={open}
        busy={false}
        fallbackGateway={gateway}
        projectGateways={new Map([['project-e2e', gateway]])}
        workspace={{
          projectId: 'project-e2e',
          projectName: 'Metapp E2E',
          cwd: '/workspace/metapp',
          provider: 'simulated-agent',
          permissionMode: 'default',
        }}
        models={[]}
        providers={[]}
        extensions={[extension]}
        onClose={() => setOpen(false)}
        onCreate={(input) => {
          setSubmission(input)
          setOpen(false)
        }}
      />
      <output data-testid="session-create-payload">
        {submission ? JSON.stringify(submission) : 'not-submitted'}
      </output>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
