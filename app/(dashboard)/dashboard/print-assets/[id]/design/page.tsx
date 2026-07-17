import { Suspense } from 'react'
import { PrintDesigner } from '@/components/print-assets/designer/PrintDesigner'

export const metadata = {
  title: 'Template Designer — RegisterDesk',
}

export default async function PrintDesignerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <PrintDesigner templateId={id} />
    </Suspense>
  )
}
