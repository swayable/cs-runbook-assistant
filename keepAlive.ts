// keepAlive.ts - Cron job to keep the service warm and rebuild the index
// Runs every 6 hours to call the /rebuild endpoint

export default async function() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting keep-alive rebuild...`);
  
  try {
    // Call the rebuild endpoint on your main service
    const response = await fetch("https://swayable--fd813c40fef411f088c442dde27851f2.web.val.run/rebuild");
    
    if (!response.ok) {
      console.error(`Rebuild failed with status ${response.status}`);
      const text = await response.text();
      console.error(`Response: ${text}`);
      return;
    }
    
    const result = await response.text();
    const duration = Date.now() - startTime;
    
    console.log(`✅ Rebuild successful (${duration}ms)`);
    console.log(`Response: ${result.slice(0, 200)}...`);
    
  } catch (error) {
    console.error(`❌ Rebuild failed:`, error);
    throw error;
  }
}
