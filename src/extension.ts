import * as vscode from 'vscode';
import { getGeminiResponse, getGeminiResponseSimulatedStream } from './llm';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import * as child_process from 'child_process';

// Simple chat panel class
class SimpleChatPanel {
  public static currentPanel: SimpleChatPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _useManualCreationMode: boolean = false;

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
            // Check if we're in project creation mode
            if (message.createProject) {
              await this._handleProjectCreation(
                message.text,
                message.dataFiles
              );
            } else {
              // Existing chat message handling code
              const userMessage = message.text;
              const messageId = Date.now().toString();

              // First add the thinking message
              this._panel.webview.postMessage({
                command: 'receiveMessage',
                text: 'Thinking...',
                sender: 'bot',
                isThinking: true,
                messageId: messageId,
              });

              try {
                // Add selected files to context if any
                let prompt = userMessage;
                if (message.files && message.files.length > 0) {
                  prompt = await this._buildPromptWithFiles(
                    userMessage,
                    message.files
                  );
                }

                // Process any attached data files if provided
                if (message.dataFiles && message.dataFiles.length > 0) {
                  // Create a datasets directory in workspace if it doesn't exist
                  const workspaceFolders = vscode.workspace.workspaceFolders;
                  if (workspaceFolders && workspaceFolders.length > 0) {
                    const targetDir = workspaceFolders[0].uri.fsPath;
                    const datasetsDir = path.join(targetDir, 'datasets');
                    await fs.promises
                      .mkdir(datasetsDir, { recursive: true })
                      .catch(() => {});

                    let filesInfo = '\n\nProcessing attached data files:';

                    // Save each attached file
                    for (const file of message.dataFiles) {
                      try {
                        // Extract base64 content
                        let content = file.content.toString();
                        const match = content.match(/^data:[^;]+;base64,(.*)$/);

                        if (match) {
                          content = Buffer.from(match[1], 'base64');

                          // Save file to datasets directory
                          const filePath = path.join(datasetsDir, file.name);
                          await fs.promises.writeFile(filePath, content);

                          filesInfo += `\n✓ Saved ${file.name} (${(
                            file.size / 1024
                          ).toFixed(2)} KB) to datasets directory.`;
                        } else {
                          filesInfo += `\n✗ Error processing ${file.name}: Invalid file format.`;
                        }
                      } catch (fileError: any) {
                        console.error(
                          `Error saving file ${file.name}:`,
                          fileError
                        );
                        filesInfo += `\n✗ Error saving ${file.name}: ${
                          fileError.message || 'Unknown error'
                        }`;
                      }
                    }

                    // Add information about saved files to the prompt
                    prompt += `\n\nUser has uploaded the following data files to the datasets directory: ${message.dataFiles
                      .map((f: any) => f.name)
                      .join(
                        ', '
                      )}. Please analyze these files if necessary for the task.`;

                    // Update the thinking message with file processing info
                    this._panel.webview.postMessage({
                      command: 'updateMessage',
                      text: `Thinking...${filesInfo}`,
                      messageId: messageId,
                      isComplete: false,
                    });
                  }
                }

                // Get response from LLM
                const self = this;
                getGeminiResponseSimulatedStream(
                  prompt,
                  (partialResponse: string) => {
                    // Update message with partial response
                    self._panel.webview.postMessage({
                      command: 'updateMessage',
                      text: partialResponse,
                      messageId: messageId,
                      isComplete: false,
                    });
                  },
                  () => {
                    // Mark message as complete when stream ends
                    self._panel.webview.postMessage({
                      command: 'updateMessage',
                      messageId: messageId,
                      isComplete: true,
                    });
                  }
                ).catch((error: Error) => {
                  console.error('Error getting response:', error);
                  self._panel.webview.postMessage({
                    command: 'updateMessage',
                    text: `Error: ${error.message}`,
                    messageId: messageId,
                    isComplete: true,
                    isError: true,
                  });
                });
              } catch (error: any) {
                console.error('Error handling message:', error);
                this._panel.webview.postMessage({
                  command: 'updateMessage',
                  text: `Error processing message: ${error.message}`,
                  messageId: messageId,
                  isComplete: true,
                  isError: true,
                });
              }
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
            /* Add style for the project creation checkbox */
            .project-checkbox {
                margin-top: 10px;
                margin-bottom: 10px;
                display: flex;
                align-items: center;
            }
            .project-checkbox input {
                margin-right: 8px;
            }
            .project-checkbox label {
                cursor: pointer;
            }
            /* File upload button styles */
            .file-upload {
                position: relative;
                display: inline-block;
                margin-right: 10px;
            }
            .file-upload input[type="file"] {
                position: absolute;
                left: 0;
                top: 0;
                opacity: 0;
                width: 100%;
                height: 100%;
                cursor: pointer;
            }
            .file-upload-btn {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 12px;
                border-radius: 4px;
                cursor: pointer;
                display: inline-block;
            }
            .file-upload-btn:hover {
                background: var(--vscode-button-hoverBackground);
            }
            .attached-files {
                margin-top: 5px;
                padding: 5px;
                font-size: 0.9em;
                color: var(--vscode-foreground);
            }
            .attached-file {
                display: inline-block;
                margin-right: 10px;
                padding: 2px 5px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                border-radius: 4px;
            }
            .remove-attached {
                margin-left: 5px;
                cursor: pointer;
                color: var(--vscode-editorError-foreground);
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
            
            <!-- Project creation checkbox -->
            <div class="project-checkbox">
                <input type="checkbox" id="createProjectCheckbox">
                <label for="createProjectCheckbox">Create Project from GitHub Template</label>
            </div>
            
            <!-- Chat input -->
            <div class="chat-input">
                <div class="file-upload">
                    <button class="file-upload-btn">📎</button>
                    <input type="file" id="fileUpload" multiple accept=".csv,.xlsx,.json,.txt">
                </div>
                <input type="text" id="userInput" placeholder="Type your message...">
                <button id="sendButton">Send</button>
            </div>
            <div id="attachedFiles" class="attached-files" style="display: none;"></div>
        </div>
        
        <script>
            const vscode = acquireVsCodeApi();
            let selectedFiles = [];
            let attachedDataFiles = []; // For storing attached data files
            
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
            
            document.getElementById('fileUpload').addEventListener('change', (event) => {
                const files = event.target.files;
                if (files.length > 0) {
                    // Clear the file input value to allow selecting the same file again
                    const fileList = Array.from(files);
                    
                    // Create file reader and process each file
                    fileList.forEach(file => {
                        const reader = new FileReader();
                        reader.onload = function(e) {
                            // Convert file to base64
                            const base64content = e.target.result;
                            
                            // Add to attachedDataFiles
                            attachedDataFiles.push({
                                name: file.name,
                                type: file.type,
                                size: file.size,
                                content: base64content
                            });
                            
                            // Update attached files display
                            updateAttachedFilesDisplay();
                        };
                        reader.readAsDataURL(file);
                    });
                    
                    // Reset the file input to allow selecting the same file again
                    event.target.value = '';
                }
            });
            
            function sendMessage() {
                const input = document.getElementById('userInput');
                const message = input.value.trim();
                const isCreateProject = document.getElementById('createProjectCheckbox').checked;
                
                if (message) {
                    // Display user message
                    let displayMessage = message;
                    if (selectedFiles.length > 0) {
                        // Add files context if files are selected
                        let fileList = '';
                        selectedFiles.forEach(file => {
                            fileList += '- ' + file.path + '\n';
                        });
                        displayMessage += '\n\n📄 Selected files:\n' + fileList;
                    }
                    
                    // Add attached data files info if any
                    if (attachedDataFiles.length > 0) {
                        let dataFileList = '';
                        attachedDataFiles.forEach(file => {
                            dataFileList += '- ' + file.name + ' (' + (file.size / 1024).toFixed(2) + ' KB)\n';
                        });
                        displayMessage += '\n\n📊 Attached data files:\n' + dataFileList;
                    }
                    
                    // Add project creation indicator if checkbox is checked
                    if (isCreateProject) {
                        displayMessage += '\n\n🏗️ Creating project using this prompt';
                    }
                    
                    addMessage(displayMessage, 'user');
                    
                    // Send message to extension with appropriate flags
                    vscode.postMessage({
                        command: 'sendMessage',
                        text: message,
                        files: selectedFiles.map(f => f.path),
                        createProject: isCreateProject,
                        dataFiles: attachedDataFiles
                    });
                    
                    // Clear input and attached files
                    input.value = '';
                    attachedDataFiles = [];
                    updateAttachedFilesDisplay();
                    
                    // If project creation, uncheck the box after sending
                    if (isCreateProject) {
                        document.getElementById('createProjectCheckbox').checked = false;
                    }
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
                        const parts = displayText.split('\n\n📄 Selected files:');
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
            
            function updateAttachedFilesDisplay() {
                const attachedFilesElement = document.getElementById('attachedFiles');
                
                if (attachedDataFiles.length > 0) {
                    attachedFilesElement.style.display = 'block';
                    attachedFilesElement.innerHTML = '';
                    
                    attachedDataFiles.forEach((file, index) => {
                        const fileElement = document.createElement('span');
                        fileElement.className = 'attached-file';
                        fileElement.innerHTML = file.name + ' <span class="remove-attached" data-index="' + index + '">✕</span>';
                        attachedFilesElement.appendChild(fileElement);
                    });
                    
                    // Add event listeners for remove buttons
                    document.querySelectorAll('.remove-attached').forEach(button => {
                        button.addEventListener('click', function() {
                            const index = parseInt(this.getAttribute('data-index'));
                            attachedDataFiles.splice(index, 1);
                            updateAttachedFilesDisplay();
                        });
                    });
                } else {
                    attachedFilesElement.style.display = 'none';
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
                        'Selected Files (' + selectedFiles.length + ')';
                    
                    // Add each selected file
                    selectedFiles.forEach((file, index) => {
                        const fileDiv = document.createElement('div');
                        fileDiv.className = 'selected-file';
                        fileDiv.innerHTML = 
                            '<span>📄 ' + (file.name || file.path) + '</span>' +
                            '<span class="remove-file" data-index="' + index + '">✖</span>';
                        container.appendChild(fileDiv);
                    });
                    
                    // Add event listeners for remove buttons
                    document.querySelectorAll('.remove-file').forEach(btn => {
                        btn.addEventListener('click', function() {
                            const index = parseInt(this.getAttribute('data-index'));
                            
                            // Update checkbox state
                            const checkbox = document.querySelector('input[data-path="' + selectedFiles[index].path + '"]');
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

  private async _handleProjectCreation(
    prompt: string,
    dataFiles: any[] = []
  ): Promise<void> {
    // Create a single message ID for the entire operation
    const messageId = Date.now().toString();
    let fullMessage = '';
    let projectCreatedSuccessfully = false;

    try {
      // First check if copier is installed
      const copierInstalled = await this._ensureCopierInstalled();
      if (!copierInstalled) {
        fullMessage =
          "Project creation requires the 'copier' Python package. Please install it and try again.";
        this._panel.webview.postMessage({
          command: 'receiveMessage',
          text: fullMessage,
          sender: 'bot',
          isThinking: false,
          messageId: messageId,
          isComplete: true,
        });
        return;
      }

      // Validate workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder is open');
      }

      // Use the first workspace folder as target
      const targetDir = workspaceFolders[0].uri.fsPath;

      // Show initial message
      fullMessage = `Creating ML project based on your prompt: "${prompt}"\n\nProcessing...`;
      this._panel.webview.postMessage({
        command: 'receiveMessage',
        text: fullMessage,
        sender: 'bot',
        isThinking: true,
        messageId: messageId,
      });

      // Extract template URL
      const templateUrl = 'https://github.com/rithik-physarum/ml-template.git';

      // Update progress
      fullMessage += `\n\nUsing template: ${templateUrl}`;
      this._panel.webview.postMessage({
        command: 'updateMessage',
        text: fullMessage,
        messageId: messageId,
        isComplete: false,
      });

      // Gather copier template questions and prompt the user
      const copierQuestions = await this._getCopierQuestions(templateUrl);
      const userAnswers = await this._promptUserForCopierAnswers(
        copierQuestions,
        prompt
      );

      // Update progress
      fullMessage +=
        '\n\nGenerating project structure with your specifications...';
      this._panel.webview.postMessage({
        command: 'updateMessage',
        text: fullMessage,
        messageId: messageId,
        isComplete: false,
      });

      try {
        // Try to create project
        await this._createProjectWithCopier(
          templateUrl,
          targetDir,
          userAnswers
        );
        projectCreatedSuccessfully = true;
      } catch (error) {
        const errorMsg = String(error);

        // If the error contains "python: command not found", it means the project structure
        // was created but the post-update script failed
        if (
          errorMsg.includes('python: command not found') ||
          errorMsg.includes(
            "Command 'python post_update_script.py' returned non-zero exit status"
          )
        ) {
          console.log(
            'Project structure created but post-processing failed. This is expected on macOS.'
          );
          fullMessage +=
            '\n\nProject structure created successfully. Running manual cleanup...';

          this._panel.webview.postMessage({
            command: 'updateMessage',
            text: fullMessage,
            messageId: messageId,
            isComplete: false,
          });

          // Run post_update_script.py with python3 manually if it exists
          const postUpdateScriptPath = path.join(
            targetDir,
            'post_update_script.py'
          );
          try {
            if (
              await fs.promises
                .access(postUpdateScriptPath)
                .then(() => true)
                .catch(() => false)
            ) {
              await this._executeCommand('python3', ['post_update_script.py'], {
                cwd: targetDir,
                shell: true,
              }).catch((e) =>
                console.error('Manual script execution failed:', e)
              );

              // Clean up files that the script would have removed
              await this._executeCommand(
                'rm',
                ['-f', '__version__.py', '__init__.py', 'pyproject.toml'],
                { cwd: targetDir, shell: true }
              ).catch((e) => console.error('Cleanup failed:', e));

              await this._executeCommand(
                'rm',
                ['-rf', '.releaserc.yml', '.bumpversion.cfg'],
                { cwd: targetDir, shell: true }
              ).catch((e) => console.error('Cleanup failed:', e));

              // Remove the script itself
              await fs.promises.unlink(postUpdateScriptPath).catch(() => {});
            }
          } catch (scriptError) {
            console.error('Manual cleanup had issues:', scriptError);
          }

          projectCreatedSuccessfully = true;
        } else {
          // For other errors, rethrow
          throw error;
        }
      }

      if (projectCreatedSuccessfully) {
        // Remove unnecessary files
        fullMessage +=
          '\n\nCleaning up unnecessary files for your specific ML needs...';
        this._panel.webview.postMessage({
          command: 'updateMessage',
          text: fullMessage,
          messageId: messageId,
          isComplete: false,
        });

        await this._removeUnnecessaryFiles(targetDir, prompt);

        // Create a datasets directory if it doesn't exist
        const datasetsDir = path.join(targetDir, 'datasets');
        await fs.promises
          .mkdir(datasetsDir, { recursive: true })
          .catch(() => {});

        // Save attached data files to the datasets directory
        if (dataFiles && dataFiles.length > 0) {
          fullMessage += '\n\nProcessing your attached data files...';
          this._panel.webview.postMessage({
            command: 'updateMessage',
            text: fullMessage,
            messageId: messageId,
            isComplete: false,
          });

          for (const file of dataFiles) {
            try {
              // Extract base64 content - strip the data URL prefix
              let content = file.content.toString();
              const match = content.match(/^data:[^;]+;base64,(.*)$/);

              if (match) {
                content = Buffer.from(match[1], 'base64');

                // Save file to datasets directory
                const filePath = path.join(datasetsDir, file.name);
                await fs.promises.writeFile(filePath, content);

                fullMessage += `\nSaved ${file.name} to datasets directory.`;
              } else {
                fullMessage += `\nError processing ${file.name}: Invalid file format.`;
              }
            } catch (fileError: any) {
              console.error(`Error saving file ${file.name}:`, fileError);
              fullMessage += `\nError saving ${file.name}: ${
                fileError.message || 'Unknown error'
              }`;
            }
          }

          this._panel.webview.postMessage({
            command: 'updateMessage',
            text: fullMessage,
            messageId: messageId,
            isComplete: false,
          });
        } else {
          // If no files were attached, create a README for datasets directory
          const readmePath = path.join(datasetsDir, 'README.md');
          if (
            !(await fs.promises
              .access(readmePath)
              .then(() => true)
              .catch(() => false))
          ) {
            await fs.promises.writeFile(
              readmePath,
              '# Datasets Directory\n\nPlace your training and testing datasets in this directory.'
            );
          }

          fullMessage +=
            '\n\nNo data files were attached. Please upload your datasets to the datasets directory.';
        }

        // Success message
        fullMessage += `\n\nML project created successfully at ${targetDir}\n\nYou can now upload your data and ask questions about building your model.`;
      }

      this._panel.webview.postMessage({
        command: 'updateMessage',
        text: fullMessage,
        messageId: messageId,
        isComplete: true,
      });
    } catch (error) {
      // Error handling
      console.error('Error creating project:', error);
      fullMessage += `\n\nError creating project: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this._panel.webview.postMessage({
        command: 'updateMessage',
        text: fullMessage,
        messageId: messageId,
        isComplete: true,
      });
    }
  }

  // Get questions from the copier template
  private async _getCopierQuestions(templateUrl: string): Promise<any[]> {
    // Instead of trying to extract questions from the template, let's define them explicitly
    // based on the template's copier.yml
    return [
      {
        name: 'author_name',
        type: 'text',
        help: 'Step 1/19 - "User\'s full name"',
        required: true,
      },
      {
        name: 'git_email',
        type: 'text',
        help: 'Step 2/19 - "User\'s email address"',
        required: true,
      },
      {
        name: 'user_uin',
        type: 'text',
        help: 'Step 3/19 - "User\'s BT UIN"',
        default: 'N/A', // For generic use
      },
      {
        name: 'user_team',
        type: 'text',
        help: 'Step 4/19 - "User\'s team"',
        default: 'ML Team', // For generic use
      },
      {
        name: 'gitlab_remote_location',
        type: 'text',
        help: 'Step 5/19 - "Parent Gitlab (remote) project location"',
        default: 'N/A', // For generic use
      },
      {
        name: 'local_repo_location',
        type: 'text',
        default: '/home/jupyter',
        help: 'Step 6/19 - "Local repo location"',
      },
      {
        name: 'repo_name',
        type: 'text',
        help: 'Step 7/19 - "Repository name for the ML project"',
        required: true,
      },
      {
        name: 'experiment_name',
        type: 'text',
        help: 'Step 8/19 - "Experiment name"',
        // Will be auto-computed based on repo_name
      },
      {
        name: 'package_name',
        type: 'text',
        help: 'Step 9/19 - "Package name in snake_case"',
        // Will be auto-computed based on repo_name
      },
      {
        name: 'project_id',
        type: 'text',
        default: 'my-ml-project',
        help: 'Step 10/19 - "Google Cloud project (if applicable)"',
      },
      {
        name: 'service_account',
        type: 'text',
        default: 'N/A',
        help: 'Step 11/19 - "Service account (if applicable)"',
      },
      {
        name: 'region',
        type: 'text',
        default: 'ind-bglr',
        help: 'Step 12/19 - "Project location"',
      },
      {
        name: 'docker_repo',
        type: 'text',
        default: 'local',
        help: 'Step 13/19 - "Docker registry"',
      },
      {
        name: 'pip_artifactory',
        type: 'text',
        default: 'pypi',
        help: 'Step 14/19 - "The pip artifactory"',
      },
      {
        name: 'exp_bucket',
        type: 'text',
        default: 'data',
        help: 'Step 15/19 - "Storage location for experiment data"',
      },
      {
        name: 'prod_bucket',
        type: 'text',
        default: 'data',
        help: 'Step 16/19 - "Storage location for production data"',
      },
      {
        name: 'training',
        type: 'boolean',
        default: true,
        help: 'Step 17/19 - "Include training pipeline in your repository"',
      },
      {
        name: 'prediction',
        type: 'boolean',
        default: true,
        help: 'Step 18/19 - "Include prediction pipeline in your repository"',
      },
      {
        name: 'monitoring',
        type: 'boolean',
        default: false,
        help: 'Step 19/19 - "Include model performance and drift monitoring"',
      },
    ];
  }

  // Prompt user for answers to copier questions
  private async _promptUserForCopierAnswers(
    questions: any[],
    userPrompt: string
  ): Promise<Record<string, any>> {
    const answers: Record<string, any> = {};

    // First, explicitly ask for name and email regardless of what we can infer
    const authorName = await vscode.window.showInputBox({
      prompt: 'Please enter your name for the ML project',
      placeHolder: 'ML Developer',
      ignoreFocusOut: true,
    });

    answers['author_name'] = authorName || 'ML Developer';

    const emailId = await vscode.window.showInputBox({
      prompt: 'Please enter your email address',
      placeHolder: 'ml.developer@example.com',
      ignoreFocusOut: true,
    });

    answers['git_email'] = emailId || 'ml.developer@example.com';

    // Try to infer some answers from the user prompt
    const projectNameMatch = userPrompt.match(
      /(?:project|model)\s+(?:for|about|on|called|named)\s+["']?([a-zA-Z0-9_-]+)["']?/i
    );

    // Process each question (skip name and email since we already handled them)
    for (const question of questions) {
      // Skip name and email since we already asked for them
      if (question.name === 'author_name' || question.name === 'git_email') {
        continue;
      }

      let answer;

      // Auto-answer for repo_name if we can extract it from prompt
      if (question.name === 'repo_name' && projectNameMatch) {
        const repoName = projectNameMatch[1].toLowerCase().replace(/\s+/g, '-');
        answer = repoName;

        // Also set derived fields
        if (questions.find((q) => q.name === 'experiment_name')) {
          answers['experiment_name'] = `ex-${repoName.replace(
            /^(bt-|ee-)/,
            ''
          )}`;
        }
        if (questions.find((q) => q.name === 'package_name')) {
          answers['package_name'] = repoName
            .replace(/^(bt-|ee-)/, '')
            .replace(/-/g, '_');
        }
      } else if (
        question.name === 'experiment_name' &&
        answers['experiment_name']
      ) {
        // Skip if already set based on repo_name
        answer = answers['experiment_name'];
      } else if (question.name === 'package_name' && answers['package_name']) {
        // Skip if already set based on repo_name
        answer = answers['package_name'];
      } else {
        // Determine what to show for the model type based on the prompt
        const isHousePriceModel =
          userPrompt.toLowerCase().includes('house price') ||
          userPrompt.toLowerCase().includes('housing price');

        // Set defaults based on the prompt
        if (question.name === 'repo_name' && !answer) {
          answer = isHousePriceModel ? 'house-price-prediction' : 'ml-project';
        } else if (question.name === 'experiment_name' && !answer) {
          const repo = isHousePriceModel
            ? 'house-price-prediction'
            : 'ml-project';
          answer = `ex-${repo}`;
        } else if (question.name === 'package_name' && !answer) {
          const repo = isHousePriceModel
            ? 'house-price-prediction'
            : 'ml-project';
          answer = repo.replace(/-/g, '_');
        } else {
          // Use default if available
          if (question.default !== undefined) {
            answer = question.default;
          } else {
            // Ask user via input box for required fields
            answer = await vscode.window.showInputBox({
              prompt: question.help || question.name,
              placeHolder: question.default,
              value: question.default,
              ignoreFocusOut: true,
            });

            // If user cancels a required field, use a sensible default
            if (answer === undefined) {
              if (question.name === 'repo_name') {
                answer = isHousePriceModel
                  ? 'house-price-prediction'
                  : 'ml-project';
              } else {
                answer = question.default || '';
              }
            }
          }
        }
      }

      answers[question.name] = answer;
    }

    // For boolean questions, ensure they are boolean
    for (const question of questions) {
      if (
        question.type === 'boolean' &&
        typeof answers[question.name] !== 'boolean'
      ) {
        answers[question.name] =
          String(answers[question.name]).toLowerCase() === 'true';
      }
    }

    // Handle prediction sub-options
    if (answers['prediction'] === true) {
      answers['prediction_batch'] = true;
      answers['prediction_vertex'] = false;
      answers['prediction_cloudrun'] = false;
      answers['prediction_aws'] = false;
    }

    return answers;
  }

  // Create project using copier
  private async _createProjectWithCopier(
    templateUrl: string,
    targetDir: string,
    answers: Record<string, any>
  ): Promise<void> {
    // Create the answers file in the target directory (not in temp)
    const answersFileName = `copier-answers-${Date.now()}.json`;
    const answersFilePath = path.join(targetDir, answersFileName);

    await fs.promises.writeFile(
      answersFilePath,
      JSON.stringify(answers, null, 2)
    );

    try {
      // Use a relative path for the answers file and add the --trust flag
      await this._executeCommand(
        'python3',
        [
          '-m',
          'copier',
          'copy',
          '--answers-file',
          answersFileName,
          '--trust',
          templateUrl,
          '.',
          '-f',
        ],
        { cwd: targetDir, shell: true }
      );

      // Let the main method handle any errors or post-processing
    } finally {
      // Clean up the answers file
      try {
        await fs.promises.unlink(answersFilePath);
      } catch (error) {
        console.error('Error removing temporary answers file:', error);
      }
    }
  }

  // Remove unnecessary files based on user prompt
  private async _removeUnnecessaryFiles(
    targetDir: string,
    userPrompt: string
  ): Promise<void> {
    // Create a list of directories and files to keep
    const keepDirectories = [
      'core/training',
      'core/prediction',
      'core/house-price-prediction',
      'notebooks',
    ];

    // Remove all directories except those in keepDirectories
    try {
      // First, check if the core directory exists
      const coreDir = path.join(targetDir, 'core');
      if (await this._pathExists(coreDir)) {
        // List all items in the core directory
        const items = await fs.promises.readdir(coreDir);
        for (const item of items) {
          // Skip if this is one of our keep directories
          if (
            ['training', 'prediction', 'house-price-prediction'].includes(item)
          ) {
            continue;
          }

          const itemPath = path.join(coreDir, item);
          const stat = await fs.promises.stat(itemPath);
          if (stat.isDirectory()) {
            await this._removeDirectory(itemPath);
            console.log(`Removed directory: ${itemPath}`);
          }
        }
      }

      // Remove env directory if it exists
      const envDir = path.join(targetDir, 'env');
      if (await this._pathExists(envDir)) {
        await this._removeDirectory(envDir);
        console.log('Removed env directory');
      }

      // Keep only exp environment directory
      const envsDir = path.join(targetDir, 'envs');
      if (await this._pathExists(envsDir)) {
        const envItems = await fs.promises.readdir(envsDir);
        for (const item of envItems) {
          if (item !== 'exp') {
            const itemPath = path.join(envsDir, item);
            const stat = await fs.promises.stat(itemPath);
            if (stat.isDirectory()) {
              await this._removeDirectory(itemPath);
              console.log(`Removed environment directory: ${itemPath}`);
            }
          }
        }
      }

      // Remove common files we don't need
      const filesToRemove = [
        '.gitlab-ci.yml',
        'common.gitlab-ci.yml.jinja',
        '.gitlab-ci.yml.jinja',
        'post_update_script.py.jinja',
      ];

      for (const file of filesToRemove) {
        const filePath = path.join(targetDir, file);
        if (await this._pathExists(filePath)) {
          await fs.promises.unlink(filePath);
        }
      }
    } catch (error) {
      console.error('Error while cleaning up directories:', error);
    }

    // Create a datasets directory if it doesn't exist
    const datasetsDir = path.join(targetDir, 'datasets');
    await fs.promises.mkdir(datasetsDir, { recursive: true });

    // Create README for datasets directory
    await fs.promises.writeFile(
      path.join(datasetsDir, 'README.md'),
      '# Datasets Directory\n\nPlace your training and testing datasets in this directory.'
    );
  }

  // Helper method to check if a path exists
  private async _pathExists(path: string): Promise<boolean> {
    return fs.promises
      .access(path)
      .then(() => true)
      .catch(() => false);
  }

  // Helper functions
  private async _executeCommand(
    command: string,
    args: string[],
    options: any
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const childProcess = child_process.spawn(command, args, options);

      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      childProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      childProcess.on('error', (error) => {
        reject(error);
      });
    });
  }

  private async _removeDirectory(directory: string): Promise<void> {
    try {
      // Use native fs.promises.rm (Node.js 14+)
      await fs.promises.rm(directory, { recursive: true, force: true });
    } catch (error) {
      // Fallback for older Node.js versions
      if (process.platform === 'win32') {
        await this._executeCommand('rd', ['/s', '/q', directory], {
          shell: true,
        });
      } else {
        await this._executeCommand('rm', ['-rf', directory], { shell: true });
      }
    }
  }

  private async _findFilesContaining(
    directory: string,
    patterns: string[]
  ): Promise<string[]> {
    const results: string[] = [];

    // Helper function to recursively search the directory
    const searchDirectory = async (dir: string, relativePath: string = '') => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const entryRelativePath = path.join(relativePath, entry.name);
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip node_modules and .git directories
          if (entry.name !== 'node_modules' && entry.name !== '.git') {
            await searchDirectory(fullPath, entryRelativePath);
          }
        } else if (entry.isFile()) {
          // Check if filename contains any of the patterns
          const lowerCaseName = entry.name.toLowerCase();
          if (
            patterns.some((pattern) =>
              lowerCaseName.includes(pattern.toLowerCase())
            )
          ) {
            results.push(entryRelativePath);
          }
        }
      }
    };

    await searchDirectory(directory);
    return results;
  }

  private async _ensureCopierInstalled(): Promise<boolean> {
    try {
      // Check if copier is installed
      await this._executeCommand('copier', ['--version'], { shell: true });
      return true;
    } catch (error) {
      // Try with full path if available
      try {
        // On some systems, the PATH isn't updated in the current session
        // Try common Python paths
        const pythonPaths = [
          path.join(os.homedir(), '.local', 'bin', 'copier'),
          path.join(
            os.homedir(),
            'AppData',
            'Local',
            'Programs',
            'Python',
            'Python*',
            'Scripts',
            'copier.exe'
          ),
        ];

        for (const possiblePath of pythonPaths) {
          try {
            // Use glob to find matches if path contains wildcards
            const matches = require('glob').sync(possiblePath);
            if (matches && matches.length > 0) {
              await this._executeCommand(matches[0], ['--version'], {
                shell: true,
              });
              return true;
            }
          } catch {
            // Continue to next path
          }
        }

        // If we get here, none of the paths worked
        throw new Error('Copier not found in common locations');
      } catch {
        // Prompt user to install copier
        const installAction = 'Install Copier';
        const manualAction = 'Manual Creation';

        const response = await vscode.window.showErrorMessage(
          'The copier package is required for ML project creation. Would you like to install it or proceed with manual creation?',
          installAction,
          manualAction
        );

        if (response === installAction) {
          try {
            // Show installation process in terminal for visibility
            const terminal = vscode.window.createTerminal(
              'Copier Installation'
            );
            terminal.show();

            if (process.platform === 'win32') {
              terminal.sendText('pip install copier');
            } else {
              terminal.sendText('pip3 install copier --user');
            }

            // Give the user instructions
            await vscode.window.showInformationMessage(
              'Installing copier in terminal. Please press "Manual Creation" after the installation completes.'
            );

            return false;
          } catch (installError) {
            vscode.window.showErrorMessage(
              `Failed to install copier: ${installError}`
            );
            return false;
          }
        } else if (response === manualAction) {
          // Proceed with a simplified project creation that doesn't use copier
          return this._useManualCreation();
        }

        return false;
      }
    }
  }

  // Add a fallback method for manual creation
  private async _useManualCreation(): Promise<boolean> {
    // Set a flag to use manual creation instead of copier
    this._useManualCreationMode = true;

    vscode.window.showInformationMessage(
      'Proceeding with simplified project creation without copier.'
    );

    return true;
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
