
export class AiController {
  constructor({ aiService }) {
    this.aiService = aiService;
    this.proxy = async (req, res) => { await this.aiService.proxy(req, res); };
  }
}



