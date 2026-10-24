-- Removing your old avatar needs read access to its row in storage.objects.
create policy "own avatar read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
