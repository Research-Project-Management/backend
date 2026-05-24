import express from 'express';

const app = express();

app.get(/^\/crossref\/doi\/(.+)/, (req, res) => {
  console.log("Raw Regex Route Matched!");
  console.log("req.path:", req.path);
  console.log("req.url:", req.url);
  console.log("req.params[0]:", req.params[0]);
  res.json({ match: "regex", param: req.params[0] });
});



const server = app.listen(9999, async () => {
  const testDoi = "10.1145/3318464.3389700";
  const encodedDoi = encodeURIComponent(testDoi);
  
  console.log("\n--- Testing Raw Regex Route ---");
  try {
    const res = await fetch(`http://localhost:9999/crossref/doi/${encodedDoi}`);
    const data = await res.json();
    console.log("Regex route response:", data);
  } catch (e) {
    console.error("Regex route failed:", e.message);
  }



  server.close();
});
