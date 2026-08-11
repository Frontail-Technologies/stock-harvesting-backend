import { getCollectionRelativeStrength, getCollectionWeeklyStrongStocks } from "../modules/market-collections/market-collections.service";

async function main() {
  for (const code of ["SENSEX", "BSE-CLASSIFIED"]) {
    console.log(`\n=== ${code} ===`);
    const metrics = await getCollectionRelativeStrength({ code, limit: 200 });
    console.log("Weekly Strong metrics count:", metrics.metrics?.length ?? 0, metrics.metrics?.map((m: any) => m.symbol));

    const sector = await getCollectionRelativeStrength({ code, limit: 100, groupBy: "sector" });
    console.log("Sector groups:", sector.groups?.length ?? 0, sector.groups?.map((g: any) => `${g.label}:${g.score}`));

    const weeklyStrong = await getCollectionWeeklyStrongStocks({ code });
    console.log("Weekly strong breakout count:", weeklyStrong.items?.length ?? 0, weeklyStrong.items?.map((i: any) => i.symbol));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
