import { LandingPage } from "@/components/landing/LandingPage";
import { CORRIDOR_REGISTRY } from "@/constants/corridors";

export default function Home() {
  return <LandingPage reviewedCorridors={CORRIDOR_REGISTRY} />;
}
