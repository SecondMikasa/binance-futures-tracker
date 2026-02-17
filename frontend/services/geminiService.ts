import { GoogleGenAI, Type } from "@google/genai";
import { MarketDataPoint, AIAnalysisResult } from '../../types';

export const analyzeMarketData = async (symbol: string, history: MarketDataPoint[]): Promise<AIAnalysisResult> => {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // Prepare the data for the prompt
    const recentData = history.slice(-10); // Analyze last 10 minutes
    const latest = recentData[recentData.length - 1];
    
    const prompt = `
      Analyze the following crypto futures market data for ${symbol} and provide a short trading insight.
      
      Current Metrics:
      - Price: ${latest.price}
      - Open Interest (OI): ${latest.openInterest}
      - Funding Rate: ${latest.fundingRate}

      Recent Trend (Last 10 mins):
      ${JSON.stringify(recentData.map(d => ({
        t: new Date(d.timestamp).toISOString(),
        p: d.price,
        oi: d.openInterest,
        fr: d.fundingRate
      })))}

      Context:
      - High OI + Positive Funding = Longs dominant (potential long squeeze if price drops).
      - High OI + Negative Funding = Shorts dominant (potential short squeeze if price rises).
      - Rising OI + Rising Price = Bullish confirmation.
      
      Return a JSON object with:
      - sentiment: "bullish", "bearish", or "neutral"
      - summary: A 1-2 sentence analysis.
      - riskLevel: "low", "medium", "high"
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            sentiment: { type: Type.STRING, enum: ['bullish', 'bearish', 'neutral'] },
            summary: { type: Type.STRING },
            riskLevel: { type: Type.STRING, enum: ['low', 'medium', 'high'] }
          },
          required: ['sentiment', 'summary', 'riskLevel']
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");

    return JSON.parse(text) as AIAnalysisResult;

  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return {
      sentiment: 'neutral',
      summary: 'AI Analysis currently unavailable. Please check API configuration.',
      riskLevel: 'low'
    };
  }
};
