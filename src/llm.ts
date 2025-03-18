// Type declaration for ReadableStream
interface ReadableStreamDefaultReader<R = any> {
  read(): Promise<{ done: boolean; value: R }>;
  releaseLock(): void;
  cancel(reason?: any): Promise<void>;
}

interface ReadableStream<R = any> {
  getReader(): ReadableStreamDefaultReader<R>;
}

export let API_KEY =
  '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'; // Default OpenRouter API key
export let MODEL = 'google/gemini-2.0-pro-exp-02-05:free'; // Default model

// Regular non-streaming response
export async function getGeminiResponse(input: string): Promise<string> {
  const { default: fetch } = await import('node-fetch');

  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: input }],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`API Error: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    choices: { message?: { content?: string } }[];
  };

  return data.choices[0]?.message?.content || 'No response received';
}

// Function to get response from Gemini with an image
export async function getGeminiResponseWithImage(
  prompt: string,
  imageData: string
): Promise<string> {
  const { default: fetch } = await import('node-fetch');

  // Extract the MIME type and actual base64 content from the data URL
  let mimeType = 'image/jpeg';
  let base64Content = imageData;

  if (imageData.startsWith('data:')) {
    const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
    if (matches && matches.length >= 3) {
      mimeType = matches[1];
      base64Content = matches[2];
    }
  }

  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: imageData, // Send the full data URL
                  detail: 'high',
                },
              },
            ],
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error: ${response.statusText}, Details: ${errorText}`);
  }

  const data = (await response.json()) as {
    choices: { message?: { content?: string } }[];
  };

  return data.choices[0]?.message?.content || 'No response received';
}

// Simulated streaming response for models that don't support real streaming
export async function getGeminiResponseSimulatedStream(
  input: string,
  onChunk: (chunk: string) => void,
  onDone: () => void
): Promise<void> {
  try {
    // Get the full response first
    const fullResponse = await getGeminiResponse(input);

    // Simulate streaming by breaking the response into chunks and
    // sending them with small delays
    const chunkSize = 5; // Characters per chunk
    const delay = 30; // Milliseconds between chunks

    for (let i = 0; i < fullResponse.length; i += chunkSize) {
      const chunk = fullResponse.substring(i, i + chunkSize);
      onChunk(chunk);
      // Add a small delay between chunks
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    onDone();
  } catch (error) {
    console.error('Streaming error:', error);
    onChunk(`Error: ${error instanceof Error ? error.message : String(error)}`);
    onDone();
  }
}

// Simulated streaming response for image-based queries
export async function getGeminiResponseWithImageSimulatedStream(
  prompt: string,
  imageData: string,
  onChunk: (chunk: string) => void,
  onDone: () => void
): Promise<void> {
  try {
    // Get the full response with image
    const fullResponse = await getGeminiResponseWithImage(prompt, imageData);

    // Simulate streaming by breaking the response into chunks and
    // sending them with small delays
    const chunkSize = 5; // Characters per chunk
    const delay = 30; // Milliseconds between chunks

    for (let i = 0; i < fullResponse.length; i += chunkSize) {
      const chunk = fullResponse.substring(i, i + chunkSize);
      onChunk(chunk);
      // Add a small delay between chunks
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    onDone();
  } catch (error) {
    console.error('Image streaming error:', error);
    onChunk(`Error: ${error instanceof Error ? error.message : String(error)}`);
    onDone();
  }
}

// Example usage:
getGeminiResponse('Hello, how are you?')
  .then((response) => console.log('AI Response:', response))
  .catch((error) => console.error('Error:', error));
