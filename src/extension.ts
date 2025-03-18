import * as vscode from 'vscode';
import {
  getGeminiResponse,
  getGeminiResponseSimulatedStream,
  getGeminiResponseWithImageSimulatedStream,
} from './llm';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

// Constants for your project
const ML_TEMPLATE_REPO = 'https://github.com/rithik-physarum/ml-template.git';

interface ChatMessage {
  text: string;
  sender: 'user' | 'bot';
  timestamp: number;
  isComplete?: boolean; // Flag to indicate if the message is complete
  isImage?: boolean;
  imageSrc?: string;
}

interface ImageData {
  path: string;
  dataUrl: string;
}

interface LLMResponse {
  content: string;
}

class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _messages: ChatMessage[] = [];
  private _workspaceFiles: string[] = [];
  private _workspaceImages: string[] = [];
  private _disposables: vscode.Disposable[] = [];
  private chatHistory: { role: string; content: string }[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;

    // Get workspace files
    this._getWorkspaceFiles().then((files) => {
      this._workspaceFiles = files.filter((file) => !this._isImageFile(file));
      this._workspaceImages = files.filter((file) => this._isImageFile(file));
      this._updateFileList();
      this._updateImageList();
    });

    // Add initial welcome message
    this._messages.push({
      text: 'Hello! How can I help you today?',
      sender: 'bot',
      timestamp: Date.now(),
      isComplete: true,
    });

    this._panel.webview.html = this._getHtmlContent();

    // Handle messages from the webview
    this._setWebviewMessageListener(this._panel.webview);

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => {
      ChatPanel.currentPanel = undefined;
    });
  }

  public static createOrShow(extensionUri: vscode.Uri): ChatPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return ChatPanel.currentPanel;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      'physarumChat',
      'Physarum Chat',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
    return ChatPanel.currentPanel;
  }

  private _setWebviewMessageListener(webview: vscode.Webview) {
    webview.onDidReceiveMessage(
      async (message: any) => {
        try {
          switch (message.command) {
            case 'sendMessage':
              await this._handleIncomingMessage(
                message.text,
                message.files || [],
                message.images || []
              );
              break;
            case 'ready':
              // Webview is ready, send initial state
              this._messages.forEach((msg) => {
                this._panel.webview.postMessage({
                  command: 'receiveMessage',
                  text: msg.text,
                  sender: msg.sender,
                  timestamp: msg.timestamp,
                  isComplete: msg.isComplete || true,
                  isImage: msg.isImage || false,
                  imageSrc: msg.imageSrc || '',
                });
              });

              // Send workspace files to webview
              this._updateFileList();
              this._updateImageList();
              break;
            case 'getImageData':
              await this._sendImageData(message.imagePath);
              break;
          }
        } catch (error) {
          // Handle errors in a user-friendly way
          console.error('Error handling message:', error);
          this._appendMessage(
            this.chatHistory,
            'assistant',
            `An error occurred: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      },
      undefined,
      this._disposables
    );
  }

  private async _handleIncomingMessage(
    text: string,
    files: string[] = [],
    imageFiles: string[] = []
  ) {
    // Create enhanced display text that includes file/image information
    let displayText = text;

    // Add file/image context to the displayed message
    if (files.length > 0 || imageFiles.length > 0) {
      displayText = text + '\n\n';

      if (files.length > 0) {
        displayText += '📄 Selected files:\n';
        files.forEach((file) => {
          displayText += `- ${file}\n`;
        });
      }

      if (imageFiles.length > 0) {
        if (files.length > 0) displayText += '\n';
        displayText += '🖼️ Selected images:\n';
        imageFiles.forEach((img) => {
          displayText += `- ${img}\n`;
        });
      }
    }

    // Add user message to history with the enhanced display text
    const userTimestamp = Date.now();
    this._messages.push({
      text: displayText, // Use enhanced text with file info
      sender: 'user',
      timestamp: userTimestamp,
      isComplete: true,
    });

    // Send user message to webview to display it with file/image info
    this._panel.webview.postMessage({
      command: 'receiveMessage',
      text: displayText, // Use enhanced text with file info
      sender: 'user',
      timestamp: userTimestamp,
      isComplete: true,
    });

    // Create an initial empty bot message
    const botMessageTimestamp = Date.now();
    this._messages.push({
      text: '',
      sender: 'bot',
      timestamp: botMessageTimestamp,
      isComplete: false,
    });

    // Send empty bot message to webview to start the streaming UI
    this._panel.webview.postMessage({
      command: 'receiveMessage',
      text: '',
      sender: 'bot',
      timestamp: botMessageTimestamp,
      isComplete: false,
    });

    // Add debug logging to track message flow
    console.log(
      'Created initial bot message with timestamp:',
      botMessageTimestamp
    );
    this._panel.webview.postMessage({
      command: 'debug',
      message: 'Sending empty bot message',
      data: {
        timestamp: botMessageTimestamp,
        messageCount: this._messages.length,
      },
    });

    let botIndex = this._messages.length - 1; // Store the bot message index specifically

    try {
      // Get workspace root folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error(
          'No workspace folder is open. Please open a folder first.'
        );
      }

      // Use the first workspace folder as root
      const rootPath = workspaceFolders[0].uri.fsPath;

      // Decide whether to include directory tree based on query content and file selection
      const includeTreeStructure = this._shouldIncludeTreeStructure(
        text,
        files,
        imageFiles
      );

      // If we have files or images, or if the question seems code-related, build a context-enhanced prompt
      if (files.length > 0 || imageFiles.length > 0 || includeTreeStructure) {
        let prompt = '';
        const fileContents: string[] = [];
        const imageDataUrls: ImageData[] = [];

        // Add the directory tree structure to the prompt if appropriate
        if (includeTreeStructure) {
          const directoryTree = this._generateDirectoryTree(3); // Limit to 3 levels deep
          prompt += directoryTree + '\n\n';
        }

        // Add a summary of selected files
        if (files.length > 0 || imageFiles.length > 0) {
          prompt += 'SELECTED FILES:\n';

          if (files.length > 0) {
            prompt += 'Text Files:\n';
            files.forEach((file) => {
              prompt += `- ${file}\n`;
            });
            prompt += '\n';
          }

          if (imageFiles.length > 0) {
            prompt += 'Image Files:\n';
            imageFiles.forEach((image) => {
              prompt += `- ${image}\n`;
            });
            prompt += '\n';
          }
        }

        // Process text files
        if (files.length > 0) {
          for (const filePath of files) {
            try {
              const absolutePath = path.join(rootPath, filePath);
              const content = fs.readFileSync(absolutePath, 'utf-8');
              fileContents.push(`File: ${filePath}\nContent:\n${content}\n\n`);
            } catch (error) {
              console.error(`Error reading file ${filePath}: ${error}`);
              fileContents.push(
                `File: ${filePath} (Error: Could not read file)\n\n`
              );
            }
          }

          // Add file contents to the prompt
          if (fileContents.length > 0) {
            prompt += 'FILE CONTENTS:\n' + fileContents.join('\n---\n\n');
          }
        }

        // Process images
        if (imageFiles.length > 0) {
          for (const imagePath of imageFiles) {
            try {
              const absolutePath = path.join(rootPath, imagePath);

              // Read the image and convert to data URL
              const imageBuffer = fs.readFileSync(absolutePath);
              const base64Image = imageBuffer.toString('base64');

              // Determine mime type based on file extension
              const ext = path.extname(absolutePath).toLowerCase();
              let mimeType = 'image/png'; // Default

              if (ext === '.jpg' || ext === '.jpeg') {
                mimeType = 'image/jpeg';
              } else if (ext === '.gif') {
                mimeType = 'image/gif';
              } else if (ext === '.webp') {
                mimeType = 'image/webp';
              } else if (ext === '.svg') {
                mimeType = 'image/svg+xml';
              } else if (ext === '.bmp') {
                mimeType = 'image/bmp';
              }

              const dataUrl = `data:${mimeType};base64,${base64Image}`;
              imageDataUrls.push({ path: imagePath, dataUrl });
            } catch (error) {
              console.error(`Error processing image ${imagePath}: ${error}`);
            }
          }
        }

        // Add user query to the prompt
        prompt += '\n\nQUERY:\n' + text;

        // Handle cases based on what we have
        if (imageDataUrls.length > 0) {
          // If we have images, we need to use the image-based API
          // Since most APIs can only handle one image at a time, we'll pick the first one
          // and describe the others in the prompt
          const firstImage = imageDataUrls[0];

          // If there are multiple images, describe the others in text
          if (imageDataUrls.length > 1) {
            prompt = `I'm sending you one image, but I'm also referencing ${
              imageDataUrls.length - 1
            } other image(s) in my query.\n\n${prompt}`;
          }

          // Show image in the message (we'll just show the first one)
          this._messages[botIndex].isImage = true;
          this._messages[botIndex].imageSrc = firstImage.dataUrl;

          // Update UI to show the image
          this._panel.webview.postMessage({
            command: 'updateMessage',
            text: 'Analyzing your request with both text and images...',
            timestamp: botMessageTimestamp,
            isComplete: false,
            isImage: true,
            imageSrc: firstImage.dataUrl,
            sender: 'bot',
          });

          // Use the image-enabled streaming function with the first image
          let responseText = '';
          await getGeminiResponseWithImageSimulatedStream(
            prompt,
            firstImage.dataUrl,
            (chunk) => {
              // Debug log
              console.log(`Received chunk of length ${chunk.length}`);
              this._panel.webview.postMessage({
                command: 'debug',
                message: 'Processing chunk',
                data: { chunkLength: chunk.length },
              });

              // Append chunk to the current response
              responseText += chunk;

              // Update the caption in the image message
              this._messages[botIndex].text = responseText;

              // Debug log
              console.log(
                `Sending update for message at index ${botIndex}, timestamp ${botMessageTimestamp}`
              );

              // Send the updated message to the webview
              this._panel.webview.postMessage({
                command: 'updateMessage',
                text: responseText,
                timestamp: botMessageTimestamp,
                sender: 'bot', // Add this explicitly
                isComplete: false,
                isImage: true,
                imageSrc: firstImage.dataUrl,
              });
            },
            () => {
              // Mark the message as complete when streaming is done
              this._messages[botIndex].isComplete = true;

              // Send the completed message to the webview
              this._panel.webview.postMessage({
                command: 'updateMessage',
                text: responseText,
                timestamp: botMessageTimestamp,
                sender: 'bot', // Add this explicitly
                isComplete: true,
                isImage: true,
                imageSrc: firstImage.dataUrl,
              });
            }
          );
        } else {
          // Text-only prompt with file contents
          let responseText = '';
          await getGeminiResponseSimulatedStream(
            prompt,
            (chunk) => {
              // Debug log
              console.log(`Received chunk of length ${chunk.length}`);
              this._panel.webview.postMessage({
                command: 'debug',
                message: 'Processing chunk',
                data: { chunkLength: chunk.length },
              });

              // Append chunk to the current response
              responseText += chunk;

              // Update the last message in the list
              this._messages[botIndex].text = responseText;

              // Debug log
              console.log(
                `Sending update for message at index ${botIndex}, timestamp ${botMessageTimestamp}`
              );

              // Send the updated message to the webview
              this._panel.webview.postMessage({
                command: 'updateMessage',
                text: responseText,
                timestamp: botMessageTimestamp,
                sender: 'bot', // Add this explicitly
                isComplete: false,
              });
            },
            () => {
              // Mark the message as complete when streaming is done
              this._messages[botIndex].isComplete = true;

              // Send the completed message to the webview
              this._panel.webview.postMessage({
                command: 'updateMessage',
                text: responseText,
                timestamp: botMessageTimestamp,
                sender: 'bot', // Add this explicitly
                isComplete: true,
              });
            }
          );
        }

        // Add this debug log before sending updates
        this._panel.webview.postMessage({
          command: 'debug',
          message: 'About to send update',
          data: {
            botIndex,
            timestamp: botMessageTimestamp,
            messageObject: this._messages[botIndex],
          },
        });
      } else {
        // No files or images - regular text message
        let responseText = '';
        await getGeminiResponseSimulatedStream(
          text,
          (chunk) => {
            // Debug log
            console.log(`Received chunk of length ${chunk.length}`);
            this._panel.webview.postMessage({
              command: 'debug',
              message: 'Processing chunk',
              data: { chunkLength: chunk.length },
            });

            // Append chunk to the current response
            responseText += chunk;

            // Update the last message in the list
            this._messages[botIndex].text = responseText;

            // Debug log
            console.log(
              `Sending update for message at index ${botIndex}, timestamp ${botMessageTimestamp}`
            );

            // Send the updated message to the webview
            this._panel.webview.postMessage({
              command: 'updateMessage',
              text: responseText,
              timestamp: botMessageTimestamp,
              sender: 'bot', // Add this explicitly
              isComplete: false,
            });
          },
          () => {
            // Mark the message as complete when streaming is done
            this._messages[botIndex].isComplete = true;

            // Send the completed message to the webview
            this._panel.webview.postMessage({
              command: 'updateMessage',
              text: responseText,
              timestamp: botMessageTimestamp,
              sender: 'bot', // Add this explicitly
              isComplete: true,
            });
          }
        );
      }
    } catch (error) {
      const errorMessage = `Error: ${
        error instanceof Error ? error.message : String(error)
      }`;

      // Update the last message with the error
      this._messages[botIndex].text = errorMessage;
      this._messages[botIndex].isComplete = true;

      // Send the error message to the webview
      this._panel.webview.postMessage({
        command: 'updateMessage',
        text: errorMessage,
        timestamp: botMessageTimestamp,
        sender: 'bot', // Always include this
        isComplete: true,
      });
    }
  }

  /**
   * Get all files in the workspace
   */
  private async _getWorkspaceFiles(): Promise<string[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }

    const files: string[] = [];

    for (const folder of workspaceFolders) {
      const folderPath = folder.uri.fsPath;
      const relativeFiles = await this._getFilesInDirectory(
        folderPath,
        folderPath
      );
      files.push(...relativeFiles);
    }

    return files;
  }

  /**
   * Recursively get all files in a directory
   */
  private async _getFilesInDirectory(
    dirPath: string,
    rootPath: string
  ): Promise<string[]> {
    const files: string[] = [];

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // Skip node_modules and .git directories
      if (
        entry.isDirectory() &&
        (entry.name === 'node_modules' || entry.name === '.git')
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = await this._getFilesInDirectory(fullPath, rootPath);
        files.push(...subFiles);
      } else {
        // Get path relative to workspace root
        const relativePath = path.relative(rootPath, fullPath);
        files.push(relativePath);
      }
    }

    return files;
  }

  /**
   * Checks if a file is an image based on its extension
   */
  private _isImageFile(filePath: string): boolean {
    const imageExtensions = [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.webp',
      '.svg',
    ];
    const extension = path.extname(filePath).toLowerCase();
    return imageExtensions.includes(extension);
  }

  /**
   * Update the file list in the webview
   */
  private _updateFileList() {
    this._panel.webview.postMessage({
      command: 'updateFileList',
      files: this._workspaceFiles,
    });
  }

  /**
   * Update the image list in the webview
   */
  private _updateImageList() {
    this._panel.webview.postMessage({
      command: 'updateImageList',
      images: this._workspaceImages,
    });
  }

  /**
   * Sends image data as a base64 URL to the webview
   */
  private async _sendImageData(imagePath: string) {
    try {
      // Get workspace root folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder is open.');
      }

      // Use the first workspace folder as root
      const rootPath = workspaceFolders[0].uri.fsPath;
      const absolutePath = path.join(rootPath, imagePath);

      // Check if the file exists
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Image not found at ${absolutePath}`);
      }

      // Read the image and convert to data URL
      const imageBuffer = fs.readFileSync(absolutePath);
      const base64Image = imageBuffer.toString('base64');

      // Determine mime type based on file extension
      const ext = path.extname(absolutePath).toLowerCase();
      let mimeType = 'image/png'; // Default

      if (ext === '.jpg' || ext === '.jpeg') {
        mimeType = 'image/jpeg';
      } else if (ext === '.gif') {
        mimeType = 'image/gif';
      } else if (ext === '.webp') {
        mimeType = 'image/webp';
      } else if (ext === '.svg') {
        mimeType = 'image/svg+xml';
      } else if (ext === '.bmp') {
        mimeType = 'image/bmp';
      }

      const dataUrl = `data:${mimeType};base64,${base64Image}`;

      // Send the data URL back to the webview
      this._panel.webview.postMessage({
        command: 'imageData',
        imagePath: imagePath,
        dataUrl: dataUrl,
      });
    } catch (error) {
      console.error(`Error getting image data: ${error}`);
    }
  }

  private _getHtmlContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Physarum Chat</title>
        <style>
        /* CSS styles here */
            body {
                font-family: var(--vscode-font-family);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
                margin: 0;
          padding: 10px;
        }
        .chat-container {
                display: flex;
                flex-direction: column;
                height: 100vh;
            }
        .chat-history {
                flex: 1;
          overflow-y: auto;
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          padding: 10px;
          margin-bottom: 10px;
          height: calc(100vh - 140px);
                display: flex;
                flex-direction: column;
        }
        .controls-container {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-bottom: 10px;
        }
        .file-selector {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        .dropdown {
          position: relative;
          display: inline-block;
          flex: 1;
        }
        .dropdown-button {
          width: 100%;
          text-align: left;
          background: var(--vscode-dropdown-background);
          color: var(--vscode-dropdown-foreground);
          border: 1px solid var(--vscode-dropdown-border);
          padding: 8px 12px;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .dropdown-content {
          display: none;
          position: absolute;
          background: var(--vscode-dropdown-background);
          border: 1px solid var(--vscode-dropdown-border);
          border-radius: 4px;
          width: 100%;
          max-height: 300px;
                overflow-y: auto;
          z-index: 10;
          padding: 5px 0;
        }
        .dropdown-content.active {
          display: block;
        }
        .tree-view {
          list-style-type: none;
          padding: 0;
          margin: 0;
        }
        .tree-item {
          padding: 4px 8px;
          cursor: pointer;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .tree-item:hover {
          background-color: var(--vscode-list-hoverBackground);
        }
        .folder {
          font-weight: bold;
        }
        .folder::before {
          content: "📁 ";
        }
        .folder.open::before {
          content: "📂 ";
        }
        .file::before {
          content: "📄 ";
        }
        .image::before {
          content: "🖼️ ";
        }
        .checkbox {
          margin-right: 6px;
        }
        .nested {
          padding-left: 15px;
          display: none;
        }
        .active {
          display: block;
        }
        .selected-files {
          margin-top: 5px;
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          padding: 5px;
          min-height: 20px;
          max-height: 100px;
          overflow-y: auto;
            }
            .message {
          margin-bottom: 15px;
          padding: 10px;
                border-radius: 8px;
                word-wrap: break-word;
          position: relative;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
          width: 100%;
          box-sizing: border-box;
            }
            .user {
          background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
          border-top-right-radius: 2px;
            }
            .bot {
          background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-editor-selectionBackground);
          border-top-left-radius: 2px;
        }
        .chat-input {
                display: flex;
          gap: 10px;
        }
        #userInput {
                flex: 1;
          padding: 8px;
                border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
        }
        button {
          background: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 8px 12px;
          border-radius: 4px;
          cursor: pointer;
        }
        button:hover {
          background: var(--vscode-button-hoverBackground);
        }
        .file-item {
                display: flex;
          justify-content: space-between;
          margin: 2px 0;
        }
        .remove-file {
          cursor: pointer;
          color: var(--vscode-errorForeground);
        }
        .scroll-to-bottom {
          position: fixed;
          bottom: 120px;
          right: 20px;
          width: 40px;
          height: 40px;
          background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
                cursor: pointer;
          opacity: 0.7;
          transition: opacity 0.3s;
          font-size: 20px;
        }
        .scroll-to-bottom:hover {
          opacity: 1;
        }
        .message::after {
          content: '';
          display: block;
          clear: both;
        }
        pre {
          background-color: rgba(0, 0, 0, 0.1);
          padding: 8px;
          border-radius: 4px;
          overflow-x: auto;
        }
        code {
          font-family: monospace;
            }
        </style>
    </head>
    <body>
      <div class="chat-container">
        <!-- Chat history (larger area) -->
        <div id="chatHistory" class="chat-history"></div>
        
        <!-- Controls below chat history -->
        <div class="controls-container">
          <!-- Selected files display -->
          <div id="selectedFiles" class="selected-files"></div>
          
          <!-- File selection controls -->
          <div class="file-selector">
            <div class="dropdown" id="fileDropdown">
              <button class="dropdown-button" id="fileDropdownBtn">Select Files</button>
              <div class="dropdown-content" id="fileDropdownContent">
                <ul class="tree-view" id="fileTree"></ul>
              </div>
            </div>
            <div class="dropdown" id="imageDropdown">
              <button class="dropdown-button" id="imageDropdownBtn">Select Images</button>
              <div class="dropdown-content" id="imageDropdownContent">
                <ul class="tree-view" id="imageTree"></ul>
              </div>
            </div>
          </div>
          
          <!-- Chat input -->
          <div class="chat-input">
            <input type="text" id="userInput" placeholder="Type your message...">
            <button id="sendButton">Send</button>
          </div>
        </div>
        
        <div id="scrollToBottom" class="scroll-to-bottom" style="display: none;">↓</div>
      </div>
      
      <script>
      const vscode = acquireVsCodeApi();
      let selectedFiles = [];
      let selectedImages = [];
      let fileTree = {};
      let imageTree = {};
      let isUserScrolling = false;
      let isNearBottom = true;
      
      // Initialize
      document.addEventListener('DOMContentLoaded', () => {
        vscode.postMessage({ command: 'ready' });
        
        // Setup dropdown toggles
        document.getElementById('fileDropdownBtn').addEventListener('click', () => {
          document.getElementById('fileDropdownContent').classList.toggle('active');
          document.getElementById('imageDropdownContent').classList.remove('active');
        });
        
        document.getElementById('imageDropdownBtn').addEventListener('click', () => {
          document.getElementById('imageDropdownContent').classList.toggle('active');
          document.getElementById('fileDropdownContent').classList.remove('active');
        });
        
        // Close dropdowns when clicking elsewhere
        document.addEventListener('click', (e) => {
          if (!e.target.closest('#fileDropdown') && !e.target.closest('#imageDropdown')) {
            document.getElementById('fileDropdownContent').classList.remove('active');
            document.getElementById('imageDropdownContent').classList.remove('active');
          }
        });
      });
      
      // Handle sending messages
      document.getElementById('sendButton').addEventListener('click', sendMessage);
      document.getElementById('userInput').addEventListener('keypress', event => {
        if (event.key === 'Enter') {
          sendMessage();
        }
      });
      
      // Handle scroll to bottom button
      document.getElementById('scrollToBottom').addEventListener('click', () => {
        scrollToBottom();
        isUserScrolling = false;
        isNearBottom = true;
        document.getElementById('scrollToBottom').style.display = 'none';
      });
      
      // Detect user scrolling
      const chatHistory = document.getElementById('chatHistory');
      chatHistory.addEventListener('scroll', () => {
        const distanceFromBottom = chatHistory.scrollHeight - chatHistory.scrollTop - chatHistory.clientHeight;
        isNearBottom = distanceFromBottom < 50;
        isUserScrolling = !isNearBottom;
        
        // Show or hide scroll button
        if (isUserScrolling) {
          document.getElementById('scrollToBottom').style.display = 'flex';
        } else {
          document.getElementById('scrollToBottom').style.display = 'none';
        }
      });
      
      function sendMessage() {
        const input = document.getElementById('userInput');
        const message = input.value.trim();
        
        if (message) {
          // Reset scrolling flags when sending a new message
          isUserScrolling = false;
          isNearBottom = true;
          
          vscode.postMessage({
            command: 'sendMessage',
            text: message,
            files: selectedFiles.map(f => f.path),
            images: selectedImages.map(i => i.path)
          });
          
          input.value = '';
          
          // Clear selected files and images after sending
          selectedFiles = [];
          selectedImages = [];
          updateSelectedFilesDisplay();
          updateFileDropdownButtonText();
          updateImageDropdownButtonText();
          
          // Reset selected checkboxes in tree
          document.querySelectorAll('#fileTree input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
          });
          document.querySelectorAll('#imageTree input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
          });
        }
      }
      
      function updateSelectedFilesDisplay() {
        const container = document.getElementById('selectedFiles');
        container.innerHTML = '';
        
        // Add files
        selectedFiles.forEach((file, index) => {
          const fileItem = document.createElement('div');
          fileItem.className = 'file-item';
          fileItem.innerHTML = \`
            <span>📄 \${file.name || file.path}</span>
            <span class="remove-file" data-type="file" data-index="\${index}">✖</span>
          \`;
          container.appendChild(fileItem);
        });
        
        // Add images
        selectedImages.forEach((image, index) => {
          const fileItem = document.createElement('div');
          fileItem.className = 'file-item';
          fileItem.innerHTML = \`
            <span>🖼️ \${image.name || image.path}</span>
            <span class="remove-file" data-type="image" data-index="\${index}">✖</span>
          \`;
          container.appendChild(fileItem);
        });
        
        // Add event listeners for remove buttons
        document.querySelectorAll('.remove-file').forEach(button => {
          button.addEventListener('click', function() {
            const type = this.getAttribute('data-type');
            const index = parseInt(this.getAttribute('data-index'));
            
            if (type === 'file') {
              selectedFiles.splice(index, 1);
            } else if (type === 'image') {
              selectedImages.splice(index, 1);
            }
            
            updateSelectedFilesDisplay();
            updateFileDropdownButtonText();
            updateImageDropdownButtonText();
            
            // Update checkbox state in tree
            if (type === 'file') {
              const checkbox = document.querySelector(\`#fileTree input[data-path="\${selectedFiles[index]?.path}"]\`);
              if (checkbox) checkbox.checked = false;
            } else if (type === 'image') {
              const checkbox = document.querySelector(\`#imageTree input[data-path="\${selectedImages[index]?.path}"]\`);
              if (checkbox) checkbox.checked = false;
            }
          });
        });
      }
      
      function updateFileDropdownButtonText() {
        const btn = document.getElementById('fileDropdownBtn');
        if (selectedFiles.length === 0) {
          btn.textContent = 'Select Files';
        } else {
          btn.textContent = \`Selected Files (\${selectedFiles.length})\`;
        }
      }
      
      function updateImageDropdownButtonText() {
        const btn = document.getElementById('imageDropdownBtn');
        if (selectedImages.length === 0) {
          btn.textContent = 'Select Images';
        } else {
          btn.textContent = \`Selected Images (\${selectedImages.length})\`;
        }
      }
      
      function buildFileTree(files) {
        const tree = {};
        
        files.forEach(filePath => {
          const parts = filePath.split('/');
          let currentLevel = tree;
          
          // Build path hierarchy
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!currentLevel[part]) {
              currentLevel[part] = { 
                isFolder: true, 
                children: {} 
              };
            }
            currentLevel = currentLevel[part].children;
          }
          
          // Add the file
          const fileName = parts[parts.length - 1];
          currentLevel[fileName] = { 
            isFolder: false, 
            path: filePath 
          };
        });
        
        return tree;
      }
      
      function renderFileTree(tree, container, isFileTree = true) {
        // Clear the container
        container.innerHTML = '';
        
        // Get sorted keys (folders first, then files)
        const keys = Object.keys(tree).sort((a, b) => {
          if (tree[a].isFolder && !tree[b].isFolder) return -1;
          if (!tree[a].isFolder && tree[b].isFolder) return 1;
          return a.localeCompare(b);
        });
        
        // Create tree items
        keys.forEach(key => {
          const item = tree[key];
          const li = document.createElement('li');
          
          if (item.isFolder) {
            // Folder
            li.className = 'tree-item folder';
            li.innerHTML = key;
            li.addEventListener('click', (e) => {
              if (e.target.tagName !== 'INPUT') {  // Don't toggle when clicking checkbox
                e.stopPropagation();
                li.classList.toggle('open');
                const nested = li.querySelector('.nested');
                if (nested) {
                  nested.classList.toggle('active');
                }
              }
            });
            
            // Add nested items
            const ul = document.createElement('ul');
            ul.className = 'tree-view nested';
            renderFileTree(item.children, ul, isFileTree);
            li.appendChild(ul);
          } else {
            // File
            const isImage = isFileTree ? false : true;
            li.className = \`tree-item \${isImage ? 'image' : 'file'}\`;
            
            // Create checkbox for selection
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'checkbox';
            checkbox.setAttribute('data-path', item.path);
            
            // Check if this file is already selected
            if (isFileTree) {
              checkbox.checked = selectedFiles.some(f => f.path === item.path);
            } else {
              checkbox.checked = selectedImages.some(i => i.path === item.path);
            }
            
            checkbox.addEventListener('change', (e) => {
              e.stopPropagation();
              const path = e.target.getAttribute('data-path');
              const name = key;
              
              if (isFileTree) {
                if (e.target.checked) {
                  // Add to selected files
                  selectedFiles.push({ path, name });
                  
                  // Request image data if it's not a regular file
                  if (!isFileTree) {
                    vscode.postMessage({
                      command: 'getImageData',
                      imagePath: path
                    });
                  }
                } else {
                  // Remove from selected files
                  const index = selectedFiles.findIndex(f => f.path === path);
                  if (index !== -1) {
                    selectedFiles.splice(index, 1);
                  }
                }
                updateFileDropdownButtonText();
              } else {
                if (e.target.checked) {
                  // Add to selected images
                  selectedImages.push({ path, name });
                  
                  // Request image data
                  vscode.postMessage({
                    command: 'getImageData',
                    imagePath: path
                  });
                } else {
                  // Remove from selected images
                  const index = selectedImages.findIndex(i => i.path === path);
                  if (index !== -1) {
                    selectedImages.splice(index, 1);
                  }
                }
                updateImageDropdownButtonText();
              }
              
              updateSelectedFilesDisplay();
            });
            
            li.appendChild(checkbox);
            li.appendChild(document.createTextNode(key));
          }
          
          container.appendChild(li);
        });
      }
      
      function smartScroll() {
        if (!isUserScrolling || isNearBottom) {
          scrollToBottom();
        }
      }
      
      function scrollToBottom() {
        const chatHistory = document.getElementById('chatHistory');
        chatHistory.scrollTop = chatHistory.scrollHeight;
      }
      
      // Handle messages from the extension
      window.addEventListener('message', event => {
        const message = event.data;
        console.log('Received message from extension:', message.command, message);
        
        try {
          switch (message.command) {
            case 'debug':
              console.log('DEBUG from extension:', message.message, message.data);
              break;
            
            case 'receiveMessage':
              console.log('Adding new message:', message.sender, message.timestamp);
              addMessage(message);
              break;
            
            case 'updateMessage':
              console.log('Updating message:', message.timestamp);
              if (!message.sender) {
                message.sender = 'bot'; // Default to bot for updates
              }
              updateMessage(message);
              break;
            
            case 'updateFileList':
              console.log('Updating file list with', message.files.length, 'files');
              handleFileList(message.files);
              break;
            
            case 'updateImageList':
              console.log('Updating image list with', message.images.length, 'images');
              handleImageList(message.images);
              break;
            
            case 'imageData':
              console.log('Received image data for', message.imagePath);
              handleImageData(message.imagePath, message.dataUrl);
              break;
            
            default:
              console.warn('Unknown command received:', message.command);
          }
        } catch (error) {
          console.error('Error processing message:', error, message);
        }
      });
      
      function addMessage(message) {
        console.log('Adding message with timestamp:', message.timestamp);
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message';
        messageDiv.classList.add(message.sender);
        messageDiv.id = "msg-" + message.timestamp;
        
        if (message.isImage) {
          messageDiv.innerHTML = \`
            <div><strong>\${message.sender === 'user' ? 'You' : 'Assistant'}:</strong></div>
            <img src="\${message.imageSrc}" style="max-width: 100%; max-height: 300px;" />
            <div>\${message.text}</div>
          \`;
        } else {
          // Format code blocks
          let formattedText = message.text;
          formattedText = formattedText.replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
          formattedText = formattedText.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
          
          messageDiv.innerHTML = \`
            <div><strong>\${message.sender === 'user' ? 'You' : 'Assistant'}:</strong></div>
            <div>\${formattedText}</div>
          \`;
        }
        
        document.getElementById('chatHistory').appendChild(messageDiv);
        smartScroll();
      }
      
      function updateMessage(message) {
        console.log('Updating message with timestamp:', message.timestamp);
        
        // Find the message element by ID
        let targetMessage = document.getElementById("msg-" + message.timestamp);
        console.log('Found target message:', !!targetMessage, 'for timestamp:', message.timestamp);

        // NEVER update the user input field
        const userInput = document.getElementById('userInput');
        if (targetMessage === userInput) {
          console.error('ERROR: Attempted to update the user input field!');
          return; // Exit immediately if trying to update the input field
        }
        
        // Only proceed with bot messages
        if (!message.sender || message.sender !== 'bot') {
          console.warn('Not updating - this is not a bot message');
          return;
        }

        // If we couldn't find the message by ID, log error and create a new one
        if (!targetMessage) {
          console.warn('Creating new bot message as no target found');
          const newMessage = document.createElement('div');
          newMessage.className = 'message bot';
          newMessage.id = "msg-" + message.timestamp;
          document.getElementById('chatHistory').appendChild(newMessage);
          targetMessage = newMessage;
        }
        
        // Update content
        try {
          if (message.isImage) {
            targetMessage.innerHTML = \`
              <div><strong>Assistant:</strong></div>
              <img src="\${message.imageSrc}" style="max-width: 100%; max-height: 300px;" />
              <div>\${message.text || ''}</div>
            \`;
          } else {
            // Format code blocks
            let formattedText = message.text || '';
            formattedText = formattedText.replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
            formattedText = formattedText.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            
            targetMessage.innerHTML = \`
              <div><strong>Assistant:</strong></div>
              <div>\${formattedText}</div>
            \`;
          }
          
          smartScroll();
        } catch (err) {
          console.error('Error updating message HTML:', err);
        }
      }
      
      function handleFileList(files) {
        // Build tree structure
        fileTree = buildFileTree(files);
        
        // Render tree
        const treeContainer = document.getElementById('fileTree');
        renderFileTree(fileTree, treeContainer, true);
      }
      
      function handleImageList(images) {
        // Build tree structure
        imageTree = buildFileTree(images);
        
        // Render tree
        const treeContainer = document.getElementById('imageTree');
        renderFileTree(imageTree, treeContainer, false);
      }
      
      function handleImageData(imagePath, dataUrl) {
        // Store image data
        const existingIndex = selectedImages.findIndex(img => img.path === imagePath);
        if (existingIndex >= 0) {
          selectedImages[existingIndex].dataUrl = dataUrl;
        } else {
          selectedImages.push({
            path: imagePath,
            name: imagePath.split('/').pop(),
            dataUrl: dataUrl
          });
        }
        
        updateSelectedFilesDisplay();
      }
      
      // Initial scroll to bottom
      scrollToBottom();
      </script>
    </body>
    </html>`;
  }

  /**
   * Check if we should include tree structure in the prompt
   * @param text User query text
   * @param files Files selected by user
   * @param imageFiles Images selected by user
   * @returns Boolean indicating if tree structure should be included
   */
  private _shouldIncludeTreeStructure(
    text: string,
    files: string[] = [],
    imageFiles: string[] = []
  ): boolean {
    // If files or images are selected, include tree structure
    if (files.length > 0 || imageFiles.length > 0) {
      return true;
    }

    // Check for keywords that might indicate project/code questions
    const codeKeywords = [
      'code',
      'project',
      'structure',
      'directory',
      'folder',
      'file',
      'function',
      'method',
      'class',
      'module',
      'import',
    ];

    const lowercaseText = text.toLowerCase();
    return codeKeywords.some((keyword) => lowercaseText.includes(keyword));
  }

  /**
   * Generates a text representation of the directory structure
   * @param maxDepth Maximum depth to display (default: 3)
   * @returns Formatted directory tree as string
   */
  private _generateDirectoryTree(maxDepth: number = 3): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return 'No workspace folders open.';
    }

    let result = 'PROJECT STRUCTURE:\n';

    for (const folder of workspaceFolders) {
      const rootPath = folder.uri.fsPath;
      result += `${folder.name}\n`;
      result += this._buildTreeForPath(rootPath, 1, maxDepth, '');
    }

    return result;
  }

  /**
   * Recursively builds tree structure for a directory
   * @param dirPath Directory path to build tree for
   * @param currentDepth Current depth in the recursion
   * @param maxDepth Maximum depth to display
   * @param indent Current indentation string
   * @returns Formatted directory tree as string
   */
  private _buildTreeForPath(
    dirPath: string,
    currentDepth: number,
    maxDepth: number,
    indent: string
  ): string {
    if (currentDepth > maxDepth) {
      return `${indent}├── ...(depth limit reached)\n`;
    }

    let result = '';

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      // First sort entries: directories first, then files
      const sortedEntries = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      // Skip specific directories
      const dirsToSkip = ['node_modules', '.git', 'dist', '.vscode'];

      // Process each entry
      for (let i = 0; i < sortedEntries.length; i++) {
        const entry = sortedEntries[i];
        const isLast = i === sortedEntries.length - 1;

        // Skip hidden files and specific directories
        if (
          entry.name.startsWith('.') ||
          (entry.isDirectory() && dirsToSkip.includes(entry.name))
        ) {
          continue;
        }

        // Use different symbols for last items
        const prefix = isLast ? '└── ' : '├── ';
        result += `${indent}${prefix}${entry.name}${
          entry.isDirectory() ? '/' : ''
        }\n`;

        if (entry.isDirectory()) {
          const newIndent = indent + (isLast ? '    ' : '│   ');
          const entryPath = path.join(dirPath, entry.name);
          result += this._buildTreeForPath(
            entryPath,
            currentDepth + 1,
            maxDepth,
            newIndent
          );
        }
      }
    } catch (error) {
      result += `${indent}├── Error reading directory: ${error}\n`;
    }

    return result;
  }

  private _appendMessage(
    history: { role: string; content: string }[],
    role: string,
    content: string
  ) {
    history.push({ role, content });

    // Send message to webview
    this._panel.webview.postMessage({
      command: 'receiveMessage',
      text: content,
      sender: role === 'assistant' ? 'bot' : 'user',
      timestamp: Date.now(),
      isComplete: true,
    });
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Activating Physarum Chatbot extension');

  let disposable = vscode.commands.registerCommand(
    'physarum-chatbot.openChat',
    () => {
      ChatPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {
  console.log('Deactivating Physarum Chatbot extension');
}
