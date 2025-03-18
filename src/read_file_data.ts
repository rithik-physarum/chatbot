import * as fs from 'fs';
import * as path from 'path';

export function processInput(input: string): {
  fileContent: string;
  remainingText: string;
} {
  const match = input.match(/@(\S+)/); // Match the first word starting with @

  if (!match) {
    throw new Error('No file path found in the input.');
  }

  const filePath = match[1]; // Extract file path
  const remainingText = input.replace(match[0], '').trim(); // Remove file path from input

  let fileContent = '';
  console.log(filePath);
  const absolutePath = path.normalize(filePath); // Resolve full path

  try {
    console.log(`hi ${absolutePath}`);
    fileContent = fs.readFileSync(absolutePath, 'utf-8'); // Read file synchronously
  } catch (error) {
    throw new Error(`Failed to read file at ${absolutePath}: ${error}`);
  }

  return { fileContent, remainingText };
}

// Example usage
// const inputString = '@./package.json This is some additional text.';
// const result = processInput(inputString);

// console.log('File Content:', result.fileContent);
// console.log('Remaining Text:', result.remainingText);
