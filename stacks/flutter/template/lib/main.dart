import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// API base is configurable at build time:
///   flutter build apk --debug --dart-define=CADDIE_API_BASE=http://10.0.2.2:8080
/// 10.0.2.2 is the Android-emulator alias for the host loopback, where the
/// proven Hono API (the react-hono stack) serves /api/tasks.
const String kDefaultApiBase = String.fromEnvironment(
  'CADDIE_API_BASE',
  defaultValue: 'http://10.0.2.2:8080',
);

void main() => runApp(const ForgeApp());

class ForgeApp extends StatelessWidget {
  const ForgeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Forge App',
      theme: ThemeData(colorSchemeSeed: Colors.amber, useMaterial3: true),
      home: TaskListScreen(apiBase: kDefaultApiBase),
    );
  }
}

class TaskListScreen extends StatefulWidget {
  const TaskListScreen({super.key, required this.apiBase, this.client});

  final String apiBase;

  /// Transport override for tests: flutter_test intercepts every
  /// HttpClient request (all return 400), so widget tests inject an
  /// [http.Client] instead of expecting real sockets.
  final http.Client? client;

  @override
  State<TaskListScreen> createState() => _TaskListScreenState();
}

class _TaskListScreenState extends State<TaskListScreen> {
  late Future<List<Task>> _tasks;

  Future<List<Task>> _fetchTasks() async {
    final client = widget.client ?? http.Client();
    try {
      final response = await client
          .get(Uri.parse('${widget.apiBase}/api/tasks'))
          .timeout(const Duration(seconds: 10));
      if (response.statusCode != 200) {
        throw HttpException('API answered ${response.statusCode}');
      }
      final decoded = jsonDecode(response.body) as List<dynamic>;
      return decoded
          .map((entry) => Task.fromJson(entry as Map<String, dynamic>))
          .toList(growable: false);
    } finally {
      if (widget.client == null) client.close();
    }
  }

  @override
  void initState() {
    super.initState();
    _tasks = _fetchTasks();
  }

  void _retry() {
    setState(() => _tasks = _fetchTasks());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Forge App')),
      body: FutureBuilder<List<Task>>(
        future: _tasks,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('API unreachable: ${snapshot.error}'),
                  const SizedBox(height: 12),
                  OutlinedButton(
                    key: const Key('retry-button'),
                    onPressed: _retry,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            );
          }
          final tasks = snapshot.data ?? const <Task>[];
          if (tasks.isEmpty) {
            return const Center(child: Text('No tasks yet.'));
          }
          return ListView.builder(
            itemCount: tasks.length,
            itemBuilder: (context, index) {
              final task = tasks[index];
              return ListTile(
                leading: Icon(task.done ? Icons.check_box : Icons.check_box_outline_blank),
                title: Text(task.title),
              );
            },
          );
        },
      ),
    );
  }
}

class Task {
  const Task({required this.id, required this.title, required this.done});

  factory Task.fromJson(Map<String, dynamic> json) {
    return Task(
      id: json['id'] as int,
      title: json['title'] as String,
      done: json['done'] as bool? ?? false,
    );
  }

  final int id;
  final String title;
  final bool done;
}
