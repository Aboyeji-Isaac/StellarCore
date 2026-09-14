import { SectionSkeleton } from "@/components/dashboard/SectionStates";

export default function DashboardLoading() {
  return (
    <main className="min-h-screen bg-[var(--black)] px-4 py-16 text-[var(--white)] sm:px-8 lg:px-12">
      <div className="mx-auto max-w-6xl space-y-8">
        <div className="h-10 w-64 animate-pulse rounded bg-[var(--ghost)]" />
        <SectionSkeleton label="dashboard" />
        <SectionSkeleton label="dashboard" />
        <SectionSkeleton label="dashboard" />
        <SectionSkeleton label="dashboard" />
      </div>
    </main>
  );
}
