import { Target, Heart } from 'lucide-react'
import type { CommunityDetails } from '@/components/wizard/eventDetailsConfig'

export function CommunityImpactSection({
  typeDetails,
}: {
  typeDetails: Record<string, unknown> | null
}) {
  const td = typeDetails as CommunityDetails | null
  if (!td) return null

  const hasCause     = !!td.causeInfo?.trim()
  const hasGoal      = !!td.impactGoal?.trim()
  const hasCampaign  = !!td.campaignInfo?.trim()
  const hasVolunteer = !!td.volunteerInstructions?.trim()

  if (!hasCause && !hasGoal && !hasCampaign && !hasVolunteer) return null

  return (
    <section className="py-10 sm:py-12" aria-label="Mission and Impact">

      <p className="mb-5 text-[10px] font-semibold uppercase tracking-widest text-primary">
        Why It Matters
      </p>

      {hasCause && (
        <p className="text-[1rem] leading-[1.75] text-foreground sm:text-[1.0625rem]">
          {td.causeInfo}
        </p>
      )}

      {hasGoal && (
        <div className="mt-6 rounded-xl border border-primary/20 bg-gradient-to-br from-primary/8 to-primary/3 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15">
              <Target className="size-3.5 text-primary" aria-hidden />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                Impact Goal
              </p>
              <p className="mt-1 text-[0.9375rem] font-semibold leading-snug text-foreground">
                {td.impactGoal}
              </p>
            </div>
          </div>
        </div>
      )}

      {hasCampaign && (
        <p className="mt-5 text-[0.9375rem] leading-[1.75] text-muted-foreground">
          {td.campaignInfo}
        </p>
      )}

      {hasVolunteer && (
        <div className="mt-6 flex items-start gap-3 rounded-xl bg-muted/30 px-4 py-4">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Heart className="size-3.5 text-primary" aria-hidden />
          </div>
          <div>
            <p className="text-[0.8125rem] font-semibold text-foreground">
              How to Get Involved
            </p>
            <p className="mt-0.5 text-[0.875rem] leading-relaxed text-muted-foreground">
              {td.volunteerInstructions}
            </p>
          </div>
        </div>
      )}

    </section>
  )
}
