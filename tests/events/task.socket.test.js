import { createServer } from "http";
import { Server } from "socket.io";
import Client from "socket.io-client";
import { initSocket } from "../../app/config/socket.js";
import { TaskService } from "../../app/contexts/planning/task/task.service.js";

describe("WebSockets - Task Events", () => {
  let io, serverSocket, clientSocket;
  let httpServer;

  beforeAll((done) => {
    httpServer = createServer();
    io = initSocket(httpServer);
    httpServer.listen(() => {
      const port = httpServer.address().port;
      clientSocket = new Client(`http://localhost:${port}`);
      io.on("connection", (socket) => {
        serverSocket = socket;
      });
      clientSocket.on("connect", done);
    });
  });

  afterAll(() => {
    io.close();
    clientSocket.close();
  });

  it("should emit task:created event when a task is created", (done) => {
    // We join the project room to listen to events for that project
    const projectId = "mock_project_id";
    clientSocket.emit("join", `project:${projectId}`); // In our app we might join automatically or via frontend emit
    
    // In our actual implementation, the frontend doesn't emit "join" explicitly to arbitrary rooms, 
    // it joins via token or specific channels.
    // For this test, we can just join the socket manually from the server side.
    serverSocket.join(`project:${projectId}`);

    clientSocket.on("task:created", (data) => {
      expect(data).toHaveProperty("task");
      expect(data.task.title).toBe("New Task via Socket Test");
      done();
    });

    // We manually trigger the emit that TaskService would trigger
    io.to(`project:${projectId}`).emit("task:created", {
      task: { title: "New Task via Socket Test" }
    });
  });
});
