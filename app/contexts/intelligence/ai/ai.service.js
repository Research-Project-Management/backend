import { Readable } from "stream";

export class AiService {
  async proxy(req, res) {
    const AI_URL = process.env.FLUX_AI_URL || "http://localhost:4000";
    const aiRes = await fetch(AI_URL + req.path, {
      method: req.method,
      headers: { 
        "content-type": req.headers["content-type"] || "application/json", 
        "x-user-id": req.user._id.toString() 
      },
      body: ["POST", "PUT", "PATCH"].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });
    
    res.status(aiRes.status);
    if (aiRes.body) {
      Readable.fromWeb(aiRes.body).pipe(res);
    } else {
      res.end();
    }
  }
}




