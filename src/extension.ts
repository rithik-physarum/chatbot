import * as vscode from 'vscode';
import { getGeminiResponse, getGeminiResponseSimulatedStream } from './llm';
import * as fs from 'fs';
import * as path from 'path';

// Simple chat panel class
class SimpleChatPanel {
  public static currentPanel: SimpleChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;

    // Load settings, but use defaults from llm.ts if not provided
    const llmModule = require('./llm');
    const useOpenRouter = vscode.workspace
      .getConfiguration()
      .get('geminiChat.useOpenRouter', true);
    const apiKey = vscode.workspace.getConfiguration().get('geminiChat.apiKey');
    const openRouterModel = vscode.workspace
      .getConfiguration()
      .get('geminiChat.openRouterModel');

    // Only update API key if provided in settings
    if (apiKey) {
      llmModule.API_KEY = apiKey;
    }

    // Only update model if provided
    if (openRouterModel) {
      llmModule.MODEL = openRouterModel;
    }

    // Set initial HTML content
    this._panel.webview.html = this._getHtmlContent();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'getFileTree':
            // Send file tree to webview
            const fileTree = await this._getWorkspaceFileTree();
            this._panel.webview.postMessage({
              command: 'fileTree',
              data: fileTree,
            });
            break;

          case 'sendMessage':
            // Show thinking indicator
            const messageId = Date.now().toString();
            this._panel.webview.postMessage({
              command: 'receiveMessage',
              text: 'Thinking...',
              sender: 'bot',
              isThinking: true,
              messageId: messageId,
            });

            try {
              // Build prompt with file contents if files are selected
              let prompt = message.text;

              if (message.files && message.files.length > 0) {
                // Only include tree structure when files are selected
                prompt = await this._buildPromptWithFiles(
                  message.text,
                  message.files
                );
              }

              // Use streaming response from Gemini API
              let fullResponse = '';

              await getGeminiResponseSimulatedStream(
                prompt, // Send the enhanced prompt with file context
                (chunk) => {
                  // Append each chunk from the API
                  fullResponse += chunk;

                  // Stream each chunk to the webview
                  this._panel.webview.postMessage({
                    command: 'updateMessage',
                    text: fullResponse,
                    messageId: messageId,
                    isComplete: false,
                  });
                },
                () => {
                  // Complete the message when streaming ends
                  this._panel.webview.postMessage({
                    command: 'updateMessage',
                    text: fullResponse,
                    messageId: messageId,
                    isComplete: true,
                  });
                }
              );
            } catch (error) {
              // Handle API errors
              this._panel.webview.postMessage({
                command: 'receiveMessage',
                text: `Error connecting to API: ${
                  error instanceof Error ? error.message : 'Unknown error'
                }`,
                sender: 'bot',
                isError: true,
              });
            }
            break;
        }
      },
      null,
      this._disposables
    );

    // Clean up when the panel is closed
    this._panel.onDidDispose(
      () => {
        SimpleChatPanel.currentPanel = undefined;
        this.dispose();
      },
      null,
      this._disposables
    );
  }

  public static createOrShow() {
    // Show in secondary column
    const column = vscode.ViewColumn.Two;

    // Reuse panel if it exists
    if (SimpleChatPanel.currentPanel) {
      SimpleChatPanel.currentPanel._panel.reveal(column);
      return;
    }

    // Create a new panel
    const panel = vscode.window.createWebviewPanel(
      'simpleChat',
      'Simple Chat',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    SimpleChatPanel.currentPanel = new SimpleChatPanel(panel);
  }

  private _getHtmlContent() {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Simple Chat</title>
        <style>
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
            }
            .chat-input {
                display: flex;
                gap: 10px;
                margin-top: 10px;
            }
            .file-selector {
                margin-bottom: 10px;
            }
            .dropdown {
                position: relative;
                display: inline-block;
                width: 100%;
            }
            .dropdown-btn {
                width: 100%;
                padding: 8px;
                background: var(--vscode-dropdown-background);
                color: var(--vscode-dropdown-foreground);
                border: 1px solid var(--vscode-dropdown-border);
                border-radius: 4px;
                cursor: pointer;
                text-align: left;
                display: flex;
                justify-content: space-between;
            }
            .dropdown-content {
                display: none;
                position: absolute;
                background-color: var(--vscode-dropdown-background);
                width: 100%;
                max-height: 300px;
                overflow-y: auto;
                box-shadow: 0px 8px 16px 0px rgba(0,0,0,0.2);
                z-index: 1;
                border-radius: 4px;
                border: 1px solid var(--vscode-dropdown-border);
            }
            .dropdown-content.show {
                display: block;
            }
            .tree-view {
                list-style-type: none;
                padding: 0;
                margin: 0;
            }
            .tree-item {
                padding: 8px 12px;
                cursor: pointer;
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
            .checkbox {
                margin-right: 5px;
            }
            .nested {
                padding-left: 20px;
                display: none;
            }
            .active {
                display: block;
            }
            .selected-files {
                margin-top: 10px;
                padding: 5px;
                border: 1px solid var(--vscode-input-border);
                border-radius: 4px;
                max-height: 60px;
                overflow-y: auto;
            }
            .selected-file {
                display: flex;
                justify-content: space-between;
                padding: 2px 5px;
            }
            .remove-file {
                cursor: pointer;
                color: var(--vscode-errorForeground);
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
            .message {
                margin-bottom: 10px;
                padding: 8px;
                border-radius: 4px;
            }
            .user {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                align-self: flex-end;
            }
            .bot {
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-editor-selectionBackground);
            }
            .thinking {
                font-style: italic;
                opacity: 0.8;
            }
            .error {
                color: var(--vscode-errorForeground);
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
            .selected-context {
                margin-top: 5px;
                padding: 5px;
                background-color: rgba(0, 0, 0, 0.05);
                border-radius: 4px;
                font-size: 0.9em;
            }
        </style>
    </head>
    <body>
        <div class="chat-container">
            <div id="chatHistory" class="chat-history">
                <!-- Messages will appear here -->
            </div>
            
            <!-- File selector dropdown -->
            <div class="file-selector">
                <div class="dropdown">
                    <button id="fileDropdownBtn" class="dropdown-btn">Select Files</button>
                    <div id="fileDropdownContent" class="dropdown-content">
                        <ul id="fileTree" class="tree-view">
                            <!-- File tree will be populated here -->
                        </ul>
                    </div>
                </div>
                <div id="selectedFiles" class="selected-files" style="display: none;">
                    <!-- Selected files will be shown here -->
                </div>
            </div>
            
            <!-- Chat input -->
            <div class="chat-input">
                <input type="text" id="userInput" placeholder="Type your message...">
                <button id="sendButton">Send</button>
            </div>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            let selectedFiles = [];
            
            // Initialize the UI
            document.addEventListener('DOMContentLoaded', () => {
                // Request file list from extension
                vscode.postMessage({ command: 'getFileTree' });
                
                // Setup dropdown toggle
                document.getElementById('fileDropdownBtn').addEventListener('click', () => {
                    document.getElementById('fileDropdownContent').classList.toggle('show');
                });
                
                // Close dropdown when clicking outside
                window.addEventListener('click', (event) => {
                    if (!event.target.matches('.dropdown-btn')) {
                        const dropdowns = document.getElementsByClassName('dropdown-content');
                        for (const dropdown of dropdowns) {
                            if (dropdown.classList.contains('show')) {
                                dropdown.classList.remove('show');
                            }
                        }
                    }
                });
            });
            
            // Send message when button is clicked
            document.getElementById('sendButton').addEventListener('click', sendMessage);
            
            // Send message when Enter key is pressed
            document.getElementById('userInput').addEventListener('keypress', event => {
                if (event.key === 'Enter') {
                    sendMessage();
                }
            });
            
            function sendMessage() {
                const input = document.getElementById('userInput');
                const message = input.value.trim();
                
                if (message) {
                    // Include selected files in the display
                    let displayMessage = message;
                    if (selectedFiles.length > 0) {
                        // Format selected files for display
                        let fileList = '';
                        selectedFiles.forEach(file => {
                            fileList += \`- \${file.path}\\n\`;
                        });
                        displayMessage += \`\\n\\n📄 Selected files:\\n\${fileList}\`;
                    }
                    
                    // Display user message
                    addMessage(displayMessage, 'user');
                    
                    // Send message to extension with selected files
                    vscode.postMessage({
                        command: 'sendMessage',
                        text: message,
                        files: selectedFiles.map(f => f.path)
                    });
                    
                    // Clear input
                    input.value = '';
                }
            }
            
            function addMessage(text, sender, options = {}) {
                const chatHistory = document.getElementById('chatHistory');
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + sender;
                
                if (options.isThinking) {
                    messageDiv.classList.add('thinking');
                }
                
                if (options.isError) {
                    messageDiv.classList.add('error');
                }
                
                // Set message ID for updating later if provided
                if (options.messageId) {
                    messageDiv.id = 'msg-' + options.messageId;
                }
                
                // Format the text (handle code blocks)
                let displayText = text;
                
                // Simple markdown-like formatting
                if (sender === 'bot' && !options.isThinking) {
                    // Format code blocks
                    displayText = displayText.replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
                    displayText = displayText.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
                }
                
                const senderLabel = sender === 'user' ? 'You: ' : 'Bot: ';
                
                if (options.isThinking) {
                    messageDiv.innerHTML = senderLabel + displayText;
                } else {
                    // For user messages with selected files, show them separately
                    if (sender === 'user' && displayText.includes('📄 Selected files:')) {
                        const parts = displayText.split('\\n\\n📄 Selected files:');
                        const userText = parts[0];
                        const filesList = '📄 Selected files:' + parts[1];
                        
                        messageDiv.innerHTML = '<div><strong>' + senderLabel + '</strong></div>' + 
                                              '<div>' + userText + '</div>' +
                                              '<div class="selected-context">' + filesList + '</div>';
                    } else {
                        messageDiv.innerHTML = '<div><strong>' + senderLabel + '</strong></div><div>' + displayText + '</div>';
                    }
                }
                
                chatHistory.appendChild(messageDiv);
                
                // Scroll to bottom
                chatHistory.scrollTop = chatHistory.scrollHeight;
                
                return messageDiv;
            }
            
            function updateMessage(messageId, text, isComplete) {
                const messageDiv = document.getElementById('msg-' + messageId);
                if (messageDiv) {
                    // Format the text
                    let displayText = text;
                    
                    // Format code blocks
                    displayText = displayText.replace(/\`\`\`([\s\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
                    displayText = displayText.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
                    
                    // Update content
                    messageDiv.innerHTML = '<div><strong>Bot: </strong></div><div>' + displayText + '</div>';
                    
                    // Remove thinking class if complete
                    if (isComplete) {
                        messageDiv.classList.remove('thinking');
                    }
                    
                    // Scroll to bottom
                    const chatHistory = document.getElementById('chatHistory');
                    chatHistory.scrollTop = chatHistory.scrollHeight;
                }
            }
            
            // Build file tree from data
            function buildFileTree(treeData) {
                const treeContainer = document.getElementById('fileTree');
                treeContainer.innerHTML = ''; // Clear existing tree
                
                // Recursively build tree
                function buildTreeNode(node, parentElement) {
                    const li = document.createElement('li');
                    li.className = 'tree-item';
                    
                    if (node.type === 'folder') {
                        // Folder node
                        li.classList.add('folder');
                        li.textContent = node.name;
                        
                        li.addEventListener('click', (e) => {
                            e.stopPropagation();
                            li.classList.toggle('open');
                            const nestedUl = li.querySelector('.nested');
                            if (nestedUl) {
                                nestedUl.classList.toggle('active');
                            }
                        });
                        
                        // Create nested list for children
                        const ul = document.createElement('ul');
                        ul.className = 'tree-view nested';
                        
                        // Add children nodes
                        if (node.children) {
                            node.children.forEach(child => {
                                buildTreeNode(child, ul);
                            });
                        }
                        
                        li.appendChild(ul);
                    } else {
                        // File node
                        li.classList.add('file');
                        
                        // Create checkbox for selection
                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.className = 'checkbox';
                        checkbox.setAttribute('data-path', node.path);
                        
                        // Check if file is already selected
                        if (selectedFiles.some(f => f.path === node.path)) {
                            checkbox.checked = true;
                        }
                        
                        checkbox.addEventListener('change', (e) => {
                            e.stopPropagation();
                            const filePath = e.target.getAttribute('data-path');
                            
                            if (e.target.checked) {
                                // Add to selected files
                                selectedFiles.push({ 
                                    path: filePath, 
                                    name: node.name 
                                });
                            } else {
                                // Remove from selected files
                                const index = selectedFiles.findIndex(f => f.path === filePath);
                                if (index !== -1) {
                                    selectedFiles.splice(index, 1);
                                }
                            }
                            
                            updateSelectedFilesDisplay();
                        });
                        
                        li.appendChild(checkbox);
                        li.appendChild(document.createTextNode(node.name));
                    }
                    
                    parentElement.appendChild(li);
                }
                
                // Build top level elements
                treeData.forEach(node => {
                    buildTreeNode(node, treeContainer);
                });
            }
            
            // Update display of selected files
            function updateSelectedFilesDisplay() {
                const container = document.getElementById('selectedFiles');
                
                if (selectedFiles.length > 0) {
                    container.style.display = 'block';
                    container.innerHTML = '';
                    
                    // Update dropdown button text
                    document.getElementById('fileDropdownBtn').textContent = 
                        \`Selected Files (\${selectedFiles.length})\`;
                    
                    // Add each selected file
                    selectedFiles.forEach((file, index) => {
                        const fileDiv = document.createElement('div');
                        fileDiv.className = 'selected-file';
                        fileDiv.innerHTML = \`
                            <span>📄 \${file.name || file.path}</span>
                            <span class="remove-file" data-index="\${index}">✖</span>
                        \`;
                        container.appendChild(fileDiv);
                    });
                    
                    // Add event listeners for remove buttons
                    document.querySelectorAll('.remove-file').forEach(btn => {
                        btn.addEventListener('click', function() {
                            const index = parseInt(this.getAttribute('data-index'));
                            
                            // Update checkbox state
                            const checkbox = document.querySelector(\`input[data-path="\${selectedFiles[index].path}"]\`);
                            if (checkbox) checkbox.checked = false;
                            
                            // Remove file from array
                            selectedFiles.splice(index, 1);
                            updateSelectedFilesDisplay();
                        });
                    });
                } else {
                    container.style.display = 'none';
                    document.getElementById('fileDropdownBtn').textContent = 'Select Files';
                }
            }
            
            // Handle messages from the extension
            window.addEventListener('message', event => {
                const message = event.data;
                
                switch (message.command) {
                    case 'receiveMessage':
                        addMessage(message.text, message.sender, {
                            isThinking: message.isThinking,
                            isError: message.isError,
                            messageId: message.messageId
                        });
                        break;
                    case 'updateMessage':
                        updateMessage(message.messageId, message.text, message.isComplete);
                        break;
                    case 'fileTree':
                        buildFileTree(message.data);
                        break;
                }
            });
        </script>
    </body>
    </html>`;
  }

  public dispose() {
    // Clean up resources
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  // Method to get workspace files and build a tree structure
  private async _getWorkspaceFileTree(): Promise<any[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }

    const rootNodes = [];

    for (const folder of workspaceFolders) {
      const rootPath = folder.uri.fsPath;
      const rootNode = {
        name: folder.name,
        type: 'folder',
        path: folder.uri.fsPath,
        children: await this._buildFileTree(rootPath, rootPath),
      };
      rootNodes.push(rootNode);
    }

    return rootNodes;
  }

  // Recursively build file tree
  private async _buildFileTree(
    dirPath: string,
    rootPath: string
  ): Promise<any[]> {
    const nodes = [];

    try {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });

      // Skip node_modules, .git, etc.
      const filteredEntries = entries.filter(
        (entry) =>
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'dist' &&
          entry.name !== 'build'
      );

      // Sort entries: folders first, then files
      filteredEntries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of filteredEntries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        if (entry.isDirectory()) {
          const node = {
            name: entry.name,
            type: 'folder',
            path: relativePath,
            children: await this._buildFileTree(fullPath, rootPath),
          };
          nodes.push(node);
        } else {
          // Skip very large files (binary files, etc.)
          const stats = await fs.promises.stat(fullPath);
          if (stats.size < 1024 * 1024) {
            // Skip files larger than 1MB
            const node = {
              name: entry.name,
              type: 'file',
              path: relativePath,
            };
            nodes.push(node);
          }
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${dirPath}:`, error);
    }

    return nodes;
  }

  // Get file content
  private async _getFileContent(filePath: string): Promise<string> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        throw new Error('No workspace folder open');
      }

      // Use the first workspace folder as root
      const rootPath = workspaceFolders[0].uri.fsPath;
      const absolutePath = path.join(rootPath, filePath);

      // Read the file
      const content = await fs.promises.readFile(absolutePath, 'utf-8');
      return content;
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      return `Error reading file: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  // Build prompt with file contents
  private async _buildPromptWithFiles(
    userQuery: string,
    filePaths: string[]
  ): Promise<string> {
    let prompt = '';

    // Add the directory tree structure first
    const directoryTree = this._generateDirectoryTree(3); // Limit to 3 levels deep
    prompt += directoryTree + '\n\n';

    // Highlight the selected files in the context
    prompt += `SELECTED FILES (marked in the directory structure above):\n`;
    for (const filePath of filePaths) {
      prompt += `- ${filePath}\n`;
    }
    prompt += '\n';

    // Add each file's content
    prompt += `FILE CONTENTS:\n\n`;
    for (const filePath of filePaths) {
      const fileContent = await this._getFileContent(filePath);
      const fileExtension = path.extname(filePath).toLowerCase();

      prompt += `FILE: ${filePath}\n`;
      prompt += `CONTENT:\n\`\`\`${
        fileExtension.substring(1) || ''
      }\n${fileContent}\n\`\`\`\n\n`;
    }

    // Add the user's query
    prompt += `USER QUERY: ${userQuery}\n\n`;

    // Add instructions for the AI
    prompt += `Please address the user's query with reference to the provided file(s) and directory structure. `;
    prompt += `When referring to code or content from these files, please specify which file you're referring to. `;
    prompt += `Consider the directory structure when providing context about file organization. `;
    prompt += `If the files don't contain information relevant to the query, please state that and provide the best answer you can.`;

    return prompt;
  }

  // Add this method to the SimpleChatPanel class
  private _generateDirectoryTree(maxDepth: number = 3): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return 'No workspace folders open.';
    }

    let result = 'DIRECTORY STRUCTURE:\n';

    for (const folder of workspaceFolders) {
      const rootPath = folder.uri.fsPath;
      result += `${folder.name}\n`;
      result += this._buildTreeForPath(rootPath, 1, maxDepth, '');
    }

    return result;
  }

  // Helper method to recursively build the tree structure
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

      // Sort entries: directories first, then files
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
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Extension activated');

  // Register command to open chat
  let disposable = vscode.commands.registerCommand(
    'physarum-chatbot.openChat',
    () => {
      SimpleChatPanel.createOrShow();
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {
  console.log('Extension deactivated');
}
